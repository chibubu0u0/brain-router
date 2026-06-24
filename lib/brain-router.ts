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

// 工具(MCP)呼叫用的模型。gpt-4o-mini 對多步驟工具編排偏弱，
// 建議在 Vercel 設 OPENAI_TOOL_MODEL 為較強的模型(例如 gpt-4o)。
function getOpenAIToolModel() {
  return process.env.OPENAI_TOOL_MODEL || getOpenAIModel();
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

// 從回應裡找出所有 MCP 工具呼叫(名稱、輸出、錯誤)
function extractMcpCalls(
  data: any
): { name: string; output: string; error: any }[] {
  const items = data.output || [];

  return items
    .filter((item: any) => item.type === "mcp_call")
    .map((item: any) => ({
      name: item.name,
      output:
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? ""),
      error: item.error ?? null,
    }));
}

// 從一段文字裡抽出 http(s) 網址
function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
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

// 核心:呼叫 OpenAI Responses API，回傳「完整」回應物件(才能看到 mcp_call)
async function callOpenAIRaw(
  messages: ChatMessage[],
  options?: { tools?: any[]; model?: string }
) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const requestBody: any = {
    model: options?.model || getOpenAIModel(),
    input: messages,
  };

  if (options?.tools && options.tools.length > 0) {
    requestBody.tools = options.tools;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${errorText}`);
  }

  return response.json();
}

// 只要最終文字(給 Router / Expert / Aggregator / 一般聊天用)
async function callOpenAIMessages(messages: ChatMessage[]) {
  const data = await callOpenAIRaw(messages);
  return extractOutputText(data);
}

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

  const {
    isMagnificIntent,
    getActiveMagnificConnection,
    getValidMagnificAccessToken,
    buildMagnificMcpTool,
    getMagnificConnectUrl,
    recordMagnificRun,
  } = await import("./tools/magnific/mcp");

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

  const slackTeamId = conversationContext?.slackTeamId || "manual";
  const slackUserId = conversationContext?.slackUserId || "manual";

  const wantsMagnific =
    agentKey === "eric" && isMagnificIntent(userMessage);

  // 3. system:人格 + 直接聊天框架(+ 需要時加上 Magnific 強制指示)
  let systemPrompt = `${buildExpertPrompt(profile)}

你現在不是 Brain Router，也不是被 Router 指派任務。
使用者是直接在 Slack 找你本人聊天。
下面會以一輪一輪的方式給你你跟使用者到目前為止的完整對話，
這些是你的記憶與上下文，請自然延續，不要重述、不要報告格式。`;

  if (wantsMagnific) {
    systemPrompt += `

【重要：Magnific 生圖規則】
使用者要你用 Magnific 產生或處理圖片。
- 你必須「實際呼叫」Magnific 工具來完成，不可以只用嘴巴說「已經生成」或「稍等我顯示」。
- Magnific 生圖可能要花一點時間。請等到真的拿到「最終圖片網址」後，再把網址直接放進你的回覆裡。
- 不要承諾「之後再給你」——沒有之後這一回合，請在這一則回覆裡就給出結果。
- 如果工具回報錯誤、或拿不到圖，就誠實說明發生什麼事，不要假裝成功。`;
  }

  // 4. 組成 Claude 式的多輪對話
  const input: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((message): ChatMessage => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    })),
  ];

  let response: string;

  if (wantsMagnific) {
    // === Magnific 工具路徑 ===
    const connection = await getActiveMagnificConnection({
      slackTeamId,
      slackUserId,
    });

    if (!connection) {
      const connectUrl = getMagnificConnectUrl({ slackTeamId, slackUserId });
      const reply = `要我用 Magnific 幫你生圖之前，先點這裡連接你的 Magnific 帳號：\n${connectUrl}\n連好後再跟我說一次要做什麼就好。`;

      await saveAgentConversationMessage({
        threadId: thread.id,
        agentKey,
        role: "assistant",
        content: reply,
        context: { ...conversationContext, agentKey },
      });

      return { agent: profile, thread, finalAnswer: reply };
    }

    try {
      const accessToken = await getValidMagnificAccessToken(connection);
      const tools = [buildMagnificMcpTool(accessToken)];

      const data = await callOpenAIRaw(input, {
        tools,
        model: getOpenAIToolModel(),
      });

      const text = extractOutputText(data);
      const calls = extractMcpCalls(data);

      // 攤開工具實際狀況
      const callErrors = calls
        .filter((c) => c.error)
        .map(
          (c) =>
            `${c.name}: ${
              typeof c.error === "string" ? c.error : JSON.stringify(c.error)
            }`
        );

      // 從工具輸出抽出圖片/資產網址，補進回覆(Slack 會自動展開預覽)
      const toolUrls = calls.flatMap((c) => extractUrls(c.output));
      const newUrls = toolUrls.filter((u) => !text.includes(u));

      let reply = text;

      if (calls.length === 0) {
        reply = `${text}\n\n(系統提醒：這次我沒有實際呼叫到 Magnific 工具——可能是模型沒觸發，或連線／工具設定有問題。)`;
      } else if (callErrors.length > 0) {
        reply = `${text}\n\n(Magnific 回報錯誤：${callErrors.join("；")})`;
      }

      if (newUrls.length > 0) {
        reply = `${reply}\n\n${newUrls.join("\n")}`;
      }

      response = reply;

      await recordMagnificRun({
        slackTeamId,
        slackUserId,
        userInput: userMessage,
        status: callErrors.length > 0 || calls.length === 0 ? "error" : "success",
        responseText: response,
        errorMessage:
          callErrors.length > 0
            ? callErrors.join("；")
            : calls.length === 0
            ? "no mcp_call made"
            : undefined,
      });
    } catch (error: any) {
      await recordMagnificRun({
        slackTeamId,
        slackUserId,
        userInput: userMessage,
        status: "error",
        errorMessage: error?.message || "Unknown error",
      });

      response = `我在用 Magnific 時出錯了：${error?.message || "未知錯誤"}`;
    }
  } else {
    // === 一般聊天路徑 ===
    response = await callOpenAIMessages(input);
  }

  // 5. 存回 assistant 回覆
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
