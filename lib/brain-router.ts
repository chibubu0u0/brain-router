import { supabaseAdmin } from "./supabase/server";
import {
  AgentProfile,
  buildRouterPrompt,
} from "./prompts/router-prompt";
import { buildExpertPrompt } from "./prompts/expert-prompt";
import { buildAggregatorPrompt } from "./prompts/aggregator-prompt";

type RoutingExpert = {
  agent_key: string;
  reason: string;
  priority: "high" | "medium" | "low";
  question_for_expert: string;
};

type RoutingResult = {
  intent: string;
  selected_experts: RoutingExpert[];
  decision_owner: string;
  needs_aggregation: boolean;
};

type ExpertResponse = {
  agent_key: string;
  display_name: string;
  reason: string;
  priority: string;
  question_for_expert: string;
  response: string;
};

function getOpenAIModel() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

function extractOutputText(data: any) {
  if (data.output_text) return data.output_text;

  const parts =
    data.output
      ?.flatMap((item: any) => item.content || [])
      ?.map((content: any) => content.text || content.value || "")
      ?.filter(Boolean) || [];

  return parts.join("\n").trim();
}

function extractJson(text: string) {
  const cleaned = text.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error(`Router did not return JSON: ${text}`);
    }

    return JSON.parse(match[0]);
  }
}

async function callOpenAI(systemPrompt: string, userMessage: string) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getOpenAIModel(),
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${errorText}`);
  }

  const data = await response.json();
  return extractOutputText(data);
}

export async function getActiveAgentProfiles(): Promise<AgentProfile[]> {
  const { data, error } = await supabaseAdmin
    .from("agent_profiles")
    .select("*")
    .eq("status", "active")
    .order("agent_key");

  if (error) {
    throw new Error(`Supabase error: ${error.message}`);
  }

  return data || [];
}

export async function routeQuestion(
  userMessage: string,
  agentProfiles: AgentProfile[]
): Promise<RoutingResult> {
  const routerPrompt = buildRouterPrompt(agentProfiles);

  const routerText = await callOpenAI(routerPrompt, userMessage);

  const routing = extractJson(routerText) as RoutingResult;

  if (!routing.selected_experts || routing.selected_experts.length === 0) {
    throw new Error("Router selected no experts.");
  }

  return routing;
}

export async function askExpertBrain(
  expert: RoutingExpert,
  userMessage: string,
  agentProfiles: AgentProfile[]
): Promise<ExpertResponse> {
  const profile = agentProfiles.find(
    (agent) => agent.agent_key === expert.agent_key
  );

  if (!profile) {
    throw new Error(`Agent profile not found: ${expert.agent_key}`);
  }

  const expertPrompt = buildExpertPrompt(profile);

  const expertUserMessage = `
這是 Brain Router 指派給你的問題。
請用你的獨立 Agent 視角回答，但不要用制式報告語氣。

原始使用者問題：
${userMessage}

Router 指派給你的重點：
${expert.question_for_expert}

參與原因：
${expert.reason}
`;

  const response = await callOpenAI(expertPrompt, expertUserMessage);

  return {
    agent_key: expert.agent_key,
    display_name: profile.display_name,
    reason: expert.reason,
    priority: expert.priority,
    question_for_expert: expert.question_for_expert,
    response,
  };
}

export async function aggregateExpertResponses(params: {
  userMessage: string;
  routing: RoutingResult;
  expertResponses: ExpertResponse[];
}) {
  const { userMessage, routing, expertResponses } = params;

  const aggregatorPrompt = buildAggregatorPrompt();

  const content = `
使用者原始問題：
${userMessage}

Brain Router 判斷：
${JSON.stringify(routing, null, 2)}

Expert Brain Responses：
${expertResponses
  .map((item) => {
    return `
Agent：${item.display_name} (${item.agent_key})
Priority：${item.priority}
Router Reason：${item.reason}
Question For Expert：${item.question_for_expert}

Response：
${item.response}
`;
  })
  .join("\n---\n")}
`;

  return callOpenAI(aggregatorPrompt, content);
}

export async function runBrainRouter(userMessage: string) {
  const agentProfiles = await getActiveAgentProfiles();

  if (agentProfiles.length === 0) {
    throw new Error("No active agent profiles found.");
  }

  const routing = await routeQuestion(userMessage, agentProfiles);

  const expertResponses = await Promise.all(
    routing.selected_experts.map((expert) =>
      askExpertBrain(expert, userMessage, agentProfiles)
    )
  );

  const finalAnswer = await aggregateExpertResponses({
    userMessage,
    routing,
    expertResponses,
  });

  return {
    routing,
    expertResponses,
    finalAnswer,
  };
}

export async function runDirectAgent(agentKey: string, userMessage: string) {
  const agentProfiles = await getActiveAgentProfiles();

  const profile = agentProfiles.find(
    (agent) => agent.agent_key === agentKey
  );

  if (!profile) {
    throw new Error(`Agent profile not found: ${agentKey}`);
  }

  const systemPrompt = buildExpertPrompt(profile);

  const directMessage = `
使用者現在是直接在 Slack 找你聊天。
你不是 Brain Router，也不是被 Router 指派任務。
你就是 ${profile.display_name}。

請用自然、像真人聊天的方式回覆。

使用者說：
${userMessage}
`;

  const response = await callOpenAI(systemPrompt, directMessage);

  return {
    agent: profile,
    finalAnswer: response,
  };
}

export async function runDirectAgentWithConversation(
  agentKey: string,
  userMessage: string,
  conversationContext: any
) {
  const {
    getOrCreateAgentConversationThread,
    saveAgentConversationMessage,
    getAgentConversationMessages,
    formatAgentConversationMessages,
  } = await import("./agent-conversations");

  const agentProfiles = await getActiveAgentProfiles();

  const profile = agentProfiles.find(
    (agent) => agent.agent_key === agentKey
  );

  if (!profile) {
    throw new Error(`Agent profile not found: ${agentKey}`);
  }

  const thread = await getOrCreateAgentConversationThread({
    ...conversationContext,
    agentKey,
  });

  await saveAgentConversationMessage({
    threadId: thread.id,
    agentKey,
    role: "user",
    content: userMessage,
    context: {
      ...conversationContext,
      agentKey,
    },
  });

  const messages = await getAgentConversationMessages(thread.id);
  const fullConversation = formatAgentConversationMessages(messages);

  const systemPrompt = buildExpertPrompt(profile);

  const directConversationMessage = `
這是你和使用者在 Slack 裡的對話紀錄。
這些內容是你的記憶與上下文，不是要你重述。

你現在不是 Brain Router。
你也不是被 Brain Router 指派任務。
使用者是直接找你本人聊天。

請自然延續對話。
不要用報告格式。
不要百科式介紹。
不要寫「以下是一些建議」。
不要寫空泛顧問句。
如果使用者只是分享偏好，你就像真人一樣接話、理解、補一點你的看法即可。

完整對話紀錄：
${fullConversation}

使用者最新訊息：
${userMessage}
`;

  const response = await callOpenAI(systemPrompt, directConversationMessage);

  await saveAgentConversationMessage({
    threadId: thread.id,
    agentKey,
    role: "assistant",
    content: response,
    context: {
      ...conversationContext,
      agentKey,
    },
  });

  return {
    agent: profile,
    thread,
    finalAnswer: response,
  };
}
