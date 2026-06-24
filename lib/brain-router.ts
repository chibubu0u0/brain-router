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

// OpenAI Responses API 的一輪訊息
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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

// 核心:直接把一個 messages 陣列丟給 OpenAI Responses API。
// 這是「像 Claude 聊天」的關鍵 —— 模型看到的是一輪一輪有角色的對話，
// 而不是被壓扁成一大段文字。
async function callOpenAIMessages(messages: ChatMessage[]) {
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
      input: messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${errorText}`);
  }

  const data = await response.json();
  return extractOutputText(data);
}

// 給 Router / Expert / Aggregator 用的單輪呼叫(沒有對話歷史)
async function callOpenAI(systemPrompt: string, userMessage: string) {
  return callOpenAIMessages([
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]);
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

  // 1. 先把使用者這句存進去
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

  // 2. 讀出這條對話到目前為止的「全部訊息」(依時間排序，已含剛存的這句)
  const history = await getAgentConversationMessages(thread.id);

  // 3. system:人格設定 + 一段「你正在直接聊天」的框架說明
  const systemPrompt = `${buildExpertPrompt(profile)}

你現在不是 Brain Router，也不是被 Router 指派任務。
使用者是直接在 Slack 找你本人聊天。
下面會以一輪一輪的方式給你你跟使用者到目前為止的完整對話，
這些是你的記憶與上下文，請自然延續，不要重述、不要報告格式。`;

  // 4. 組成 Claude 式的多輪對話:system + 逐輪 user/assistant 歷史
  const input: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((message): ChatMessage => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    })),
  ];

  const response = await callOpenAIMessages(input);

  // 5. 把這次回覆也存回去，下一輪就記得
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
