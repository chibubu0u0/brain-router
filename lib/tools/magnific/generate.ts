// =====================================================================
// Magnific 背景生圖 — 單次呼叫版(修「Creation not found」)
// 放到:lib/tools/magnific/generate.ts(覆蓋現有)
//
// 關鍵修正:不再把「生圖」和「查狀態」拆兩段、由程式接力 id
// (那會接到錯的識別碼 → Creation not found)。
// 改成「一次模型呼叫裡，由模型自己 生圖→等完成→取網址」,
// 識別碼全程留在模型上下文,不會接錯。查不到時可用列出最近作品自我修正。
// =====================================================================

import { supabaseAdmin } from "@/lib/supabase/server";
import {
  getActiveMagnificConnection,
  getValidMagnificAccessToken,
  getMagnificConnectUrl,
} from "./mcp";

const ERIC_BOT_TOKEN_ENV = "SLACK_ERIC_BOT_TOKEN";
const OPENAI_MCP_TIMEOUT_MS = 110_000;
const INLINE_POLL_WINDOW_MS = 180_000;
const POLL_INTERVAL_MS = 12_000;

const MAGNIFIC_ALLOWED_TOOLS = [
  "images_generate",
  "creations_wait",
  "creations_get",
  "creation_status",
  "creations_list",
  "creations_search",
];

function getOpenAIToolModel() {
  return process.env.OPENAI_TOOL_MODEL || process.env.OPENAI_MODEL || "gpt-4o";
}

function parseFirstJson(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function errToStr(error: any): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (Array.isArray(error?.content)) {
    return error.content.map((c: any) => c?.text || "").filter(Boolean).join(" ");
  }
  return JSON.stringify(error);
}

function extractMcpCalls(
  data: any
): { name: string; output: string; error: any }[] {
  const items = data.output || [];
  return items
    .filter((i: any) => i.type === "mcp_call")
    .map((i: any) => ({
      name: i.name,
      output:
        typeof i.output === "string" ? i.output : JSON.stringify(i.output ?? ""),
      error: i.error ?? null,
    }));
}

async function magnificModelCall(
  accessToken: string,
  systemInstruction: string,
  userText: string
): Promise<{ text: string; calls: { name: string; output: string; error: any }[] }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const tool = {
    type: "mcp",
    server_label: "magnific",
    server_url: process.env.MAGNIFIC_MCP_SERVER_URL,
    authorization: accessToken,
    require_approval: "never",
    allowed_tools: MAGNIFIC_ALLOWED_TOOLS,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(OPENAI_MCP_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getOpenAIToolModel(),
      input: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userText },
      ],
      tools: [tool],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${errorText}`);
  }

  const data = await response.json();
  const calls = extractMcpCalls(data);

  let text = data.output_text || "";
  if (!text) {
    const parts =
      data.output
        ?.flatMap((item: any) => item.content || [])
        ?.map((c: any) => c.text || c.value || "")
        ?.filter(Boolean) || [];
    text = parts.join("\n").trim();
  }

  return { text, calls };
}

type MagnificResult = {
  status: "done" | "processing" | "error";
  imageUrl: string;
  webUrl: string;
  creationId: string;
  detail: string;
};

function readResult(text: string, calls: { name: string; error: any }[]): MagnificResult {
  const toolErrs = calls
    .filter((c) => c.error)
    .map((c) => `${c.name}: ${errToStr(c.error)}`);

  const json = parseFirstJson(text);

  const status: "done" | "processing" | "error" =
    json?.status === "done" || json?.status === "error" ? json.status : "processing";

  return {
    status,
    imageUrl: json?.image_url || "",
    webUrl: json?.web_url || "",
    creationId: json?.creation_id || "",
    detail: json?.detail || toolErrs.join("; ") || "",
  };
}

// 一次完成:生圖 → 等完成 → 取網址。識別碼全程留在模型上下文。
export async function generateMagnificImage(
  accessToken: string,
  prompt: string
): Promise<MagnificResult> {
  const system = `你可以使用 Magnific 工具。請完成一次「生圖並取得最終圖片」的任務:
1. 用 images_generate 生成圖片。記住它回傳的「creation 識別碼」(用它實際回的那個,不要自己編)。
2. 用 creations_wait,identifiers 帶上「步驟1 拿到的同一個識別碼」,等它真的完成。
3. 從完成結果取:
   - image_url:可直接顯示的圖片檔網址(url / originalUrl / previewUrl)。
   - web_url:這個 creation 在 Magnific 的可開啟頁面連結(webUrl / 分享連結)。
注意:不要用任何「你沒見過、自己想像」的識別碼。識別碼一律用工具實際回傳的值。
若 creations_wait 報「找不到」,改用 creations_list 列出最近的生成、挑出剛剛這張(最新、符合題目)的那筆,取它的網址。
只回一個 JSON:
{"status":"done|processing|error","image_url":"...","web_url":"...","creation_id":"<最終 creation 識別碼>","detail":"<失敗或異常原因>"}
若這一回合內就拿到圖,status 用 done。不要任何多餘文字。`;

  const { text, calls } = await magnificModelCall(
    accessToken,
    system,
    `生成這張圖:${prompt}`
  );

  return readResult(text, calls);
}

// 背景補查(給 job 用):用「最近作品 + 題目」找回那張圖,避免 id 接錯。
export async function recheckMagnificByPrompt(
  accessToken: string,
  prompt: string,
  creationId: string
): Promise<MagnificResult> {
  const system = `你可以使用 Magnific 工具。請找出最近這張生成圖並取得它的最終網址。
- 先試 creations_wait / creations_get(creation 識別碼:"${creationId}")。
- 若找不到,用 creations_list 列出最近的生成,挑出符合題目「${prompt}」、最新且已完成的那一筆。
取 image_url(可直接顯示的圖檔)與 web_url(Magnific 頁面連結)。
只有 Magnific 明確說這張失敗才回 status:"error";還在處理中就回 "processing"。
只回一個 JSON:{"status":"done|processing|error","image_url":"...","web_url":"...","creation_id":"...","detail":"..."}`;

  const { text, calls } = await magnificModelCall(
    accessToken,
    system,
    `找回題目「${prompt}」這張圖`
  );

  return readResult(text, calls);
}

async function postToSlack(
  botToken: string,
  params: { channel: string; text: string; thread_ts?: string | null }
) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: params.channel,
      text: params.text,
      thread_ts: params.thread_ts || undefined,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Slack chat.postMessage error: ${data.error || response.status}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSuccessText(r: MagnificResult): string {
  if (r.imageUrl) {
    return `圖好了 👇\n${r.imageUrl}${r.webUrl ? `\n(在 Magnific 開啟:${r.webUrl})` : ""}`;
  }
  return `圖生好了!直接圖檔抓不到,在 Magnific 開啟看／下載 👇\n${r.webUrl}`;
}

async function saveMemory(
  job: {
    agent_key?: string;
    slack_team_id: string;
    slack_channel_id: string;
    slack_user_id: string;
  },
  role: "user" | "assistant",
  content: string
) {
  const { getOrCreateAgentConversationThread, saveAgentConversationMessage } =
    await import("@/lib/agent-conversations");

  const ctx = {
    source: "slack",
    projectKey: "brain_router",
    slackTeamId: job.slack_team_id,
    slackChannelId: job.slack_channel_id,
    slackUserId: job.slack_user_id,
    agentKey: job.agent_key || "eric",
  };

  const thread = await getOrCreateAgentConversationThread(ctx);
  await saveAgentConversationMessage({
    threadId: thread.id,
    agentKey: job.agent_key || "eric",
    role,
    content,
    context: ctx,
  });
}

// cron / 補查用:處理一筆 pending job
export async function processMagnificJob(job: any): Promise<boolean> {
  const botToken = process.env[ERIC_BOT_TOKEN_ENV];
  if (!botToken) return false;

  try {
    const connection = await getActiveMagnificConnection({
      slackTeamId: job.slack_team_id || "manual",
      slackUserId: job.slack_user_id || "manual",
    });
    if (!connection) return false;

    const accessToken = await getValidMagnificAccessToken(connection);
    const r = await recheckMagnificByPrompt(
      accessToken,
      job.user_input || "",
      job.creation_id || ""
    );

    if (job.id) {
      await supabaseAdmin
        .from("magnific_jobs")
        .update({ attempts: (job.attempts || 0) + 1, updated_at: new Date().toISOString() })
        .eq("id", job.id);
    }

    if (r.status === "done" && (r.imageUrl || r.webUrl)) {
      if (job.id) {
        await supabaseAdmin
          .from("magnific_jobs")
          .update({ status: "done", result_url: r.imageUrl || r.webUrl, updated_at: new Date().toISOString() })
          .eq("id", job.id);
      }
      await postToSlack(botToken, {
        channel: job.slack_channel_id,
        text: buildSuccessText(r),
        thread_ts: job.slack_thread_ts,
      });
      await saveMemory(job, "assistant", buildSuccessText(r));
      return true;
    }

    if (r.status === "error") {
      if (job.id) {
        await supabaseAdmin
          .from("magnific_jobs")
          .update({ status: "error", error_message: r.detail || "Magnific 回報失敗", updated_at: new Date().toISOString() })
          .eq("id", job.id);
      }
      await postToSlack(botToken, {
        channel: job.slack_channel_id,
        text:
          (r.detail ? `這張圖失敗了。原因:${r.detail}` : "這張圖生成失敗了。") +
          `\n(creation id: ${job.creation_id} — 可到 Magnific 作品庫查)`,
        thread_ts: job.slack_thread_ts,
      });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// 入口:Slack 收到生圖請求(跑在背景)
export async function handleMagnificRequest(params: {
  agentKey: string;
  userMessage: string;
  botToken: string;
  slackTeamId: string;
  slackChannelId: string;
  slackUserId: string;
  slackThreadTs?: string | null;
}) {
  const {
    agentKey,
    userMessage,
    botToken,
    slackTeamId,
    slackChannelId,
    slackUserId,
    slackThreadTs,
  } = params;

  const jobCtx = {
    agent_key: agentKey,
    slack_team_id: slackTeamId,
    slack_channel_id: slackChannelId,
    slack_user_id: slackUserId,
    slack_thread_ts: slackThreadTs || null,
  };

  await saveMemory(jobCtx, "user", userMessage);

  const connection = await getActiveMagnificConnection({ slackTeamId, slackUserId });
  if (!connection) {
    const url = getMagnificConnectUrl({ slackTeamId, slackUserId });
    await postToSlack(botToken, {
      channel: slackChannelId,
      text: `要我用 Magnific 幫你生圖之前,先點這裡連接你的 Magnific 帳號:\n${url}\n連好後再跟我說一次要做什麼就好。`,
      thread_ts: slackThreadTs,
    });
    return;
  }

  await postToSlack(botToken, {
    channel: slackChannelId,
    text: "🎨 收到,開始生成了,完成後我會把圖貼上來。",
    thread_ts: slackThreadTs,
  });

  // 主路徑:一次呼叫,生圖→等完成→取圖
  let result: MagnificResult;
  try {
    const accessToken = await getValidMagnificAccessToken(connection);
    result = await generateMagnificImage(accessToken, userMessage);
  } catch (error: any) {
    await postToSlack(botToken, {
      channel: slackChannelId,
      text: `生成時出錯了:${error?.message || "未知錯誤"}`,
      thread_ts: slackThreadTs,
    });
    return;
  }

  if (result.status === "done" && (result.imageUrl || result.webUrl)) {
    await postToSlack(botToken, {
      channel: slackChannelId,
      text: buildSuccessText(result),
      thread_ts: slackThreadTs,
    });
    await saveMemory(jobCtx, "assistant", buildSuccessText(result));
    return;
  }

  if (result.status === "error") {
    await postToSlack(botToken, {
      channel: slackChannelId,
      text:
        (result.detail ? `這張圖失敗了。原因:${result.detail}` : "這張圖生成失敗了。") +
        (result.creationId ? `\n(creation id: ${result.creationId} — 可到 Magnific 作品庫查)` : ""),
      thread_ts: slackThreadTs,
    });
    return;
  }

  // 還在處理 → 建 job,就地再補查幾輪;之後也可由 cron 接手
  const { data: job } = await supabaseAdmin
    .from("magnific_jobs")
    .insert({
      ...jobCtx,
      creation_id: result.creationId || null,
      user_input: userMessage,
      status: "pending",
    })
    .select("*")
    .single();

  const trackingJob = job || { id: null, ...jobCtx, creation_id: result.creationId, user_input: userMessage };

  const deadline = Date.now() + INLINE_POLL_WINDOW_MS;
  while (Date.now() + POLL_INTERVAL_MS + OPENAI_MCP_TIMEOUT_MS < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const finished = await processMagnificJob(trackingJob);
    if (finished) return;
  }

  await postToSlack(botToken, {
    channel: slackChannelId,
    text: `這張生成比較久,圖正在 Magnific 產出,你現在就能到 Magnific 作品庫看。我這邊一拿到完成圖也會盡量補上來。`,
    thread_ts: slackThreadTs,
  });
}
