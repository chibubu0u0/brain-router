// =====================================================================
// Magnific 背景生圖(兩段式 + 輪詢)
// 放到:lib/tools/magnific/generate.ts
//
// 設計重點:讓「模型」負責呼叫 Magnific 工具、並把結果整理成乾淨 JSON
// 回給程式(creation_id / status / image_url),程式只認這個 JSON。
// 這樣即使 Magnific 的原始回傳格式我們沒看過,也能穩定運作。
//
// 流程:
//   handleMagnificRequest(啟動時呼叫,跑在 Slack 事件的背景)
//     → 存使用者訊息 → 檢查連線 → 回「生成中」
//     → startMagnificGeneration 拿 creation_id → 建 job
//     → 先就地輪詢 ~45 秒(多數圖會在此完成 → 直接貼圖)
//     → 還沒好就留著 job,交給 /api/magnific/poll(cron)完成
// =====================================================================

import { supabaseAdmin } from "@/lib/supabase/server";
import {
  getActiveMagnificConnection,
  getValidMagnificAccessToken,
  getMagnificConnectUrl,
} from "./mcp";

const ERIC_BOT_TOKEN_ENV = "SLACK_ERIC_BOT_TOKEN";

function getOpenAIToolModel() {
  return process.env.OPENAI_TOOL_MODEL || process.env.OPENAI_MODEL || "gpt-4o";
}

// 從一段文字裡抓出第一個 JSON 物件
function parseFirstJson(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// 呼叫 OpenAI Responses + Magnific MCP 工具,跑一個指定指令,回傳最終文字
async function magnificModelCall(
  accessToken: string,
  systemInstruction: string,
  userText: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const tool = {
    type: "mcp",
    server_label: "magnific",
    server_url: process.env.MAGNIFIC_MCP_SERVER_URL,
    authorization: accessToken,
    require_approval: "never",
    // 只載入生圖/查詢需要的工具,大幅降低 token(避免 TPM 上限)
    allowed_tools: [
      "images_generate",
      "creation_status",
      "creations_get",
      "creations_wait",
    ],
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
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

  if (data.output_text) return data.output_text;

  const parts =
    data.output
      ?.flatMap((item: any) => item.content || [])
      ?.map((c: any) => c.text || c.value || "")
      ?.filter(Boolean) || [];

  return parts.join("\n").trim();
}

// 啟動生成,拿到 creation_id(不等它完成)
export async function startMagnificGeneration(
  accessToken: string,
  prompt: string
): Promise<string | null> {
  const system = `你可以使用 Magnific 工具。
請呼叫 images_generate 開始生成圖片，「不要」等它完成。
呼叫完成後，只回一個 JSON，格式為：{"creation_id":"<images_generate 回傳的識別碼>"}
不要任何多餘文字、不要解釋。`;

  const text = await magnificModelCall(accessToken, system, `生成這張圖：${prompt}`);
  const json = parseFirstJson(text);

  return json?.creation_id || null;
}

// 查詢某個 creation 的狀態
export async function checkMagnificStatus(
  accessToken: string,
  creationId: string
): Promise<{ status: "processing" | "done" | "error"; imageUrl: string }> {
  const system = `你可以使用 Magnific 工具。
請查詢識別碼為 ${creationId} 的生成狀態(用 creation_status，必要時再用 creations_get)，
identifiers 欄位務必帶 ["${creationId}"]。
只回一個 JSON，格式為：{"status":"processing|done|error","image_url":"<完成時的圖片 webUrl，否則空字串>"}
不要任何多餘文字。`;

  const text = await magnificModelCall(
    accessToken,
    system,
    `查詢 ${creationId} 的狀態`
  );
  const json = parseFirstJson(text);

  const status =
    json?.status === "done" || json?.status === "error"
      ? json.status
      : "processing";

  return { status, imageUrl: json?.image_url || "" };
}

async function postToSlack(
  botToken: string,
  params: { channel: string; text: string; thread_ts?: string | null }
) {
  await fetch("https://slack.com/api/chat.postMessage", {
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
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 處理一個 job:查狀態,完成就貼圖到 Slack,並更新 job
// 回傳 true 表示已結案(done/error),false 表示還在處理中
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
    const { status, imageUrl } = await checkMagnificStatus(
      accessToken,
      job.creation_id
    );

    await supabaseAdmin
      .from("magnific_jobs")
      .update({ attempts: (job.attempts || 0) + 1, updated_at: new Date().toISOString() })
      .eq("id", job.id);

    if (status === "done" && imageUrl) {
      await supabaseAdmin
        .from("magnific_jobs")
        .update({ status: "done", result_url: imageUrl, updated_at: new Date().toISOString() })
        .eq("id", job.id);

      await postToSlack(botToken, {
        channel: job.slack_channel_id,
        text: `圖好了 👇\n${imageUrl}`,
        thread_ts: job.slack_thread_ts,
      });

      await saveAssistantMemory(job, `圖好了：${imageUrl}`);
      return true;
    }

    if (status === "error") {
      await supabaseAdmin
        .from("magnific_jobs")
        .update({ status: "error", error_message: "Magnific 回報生成失敗", updated_at: new Date().toISOString() })
        .eq("id", job.id);

      await postToSlack(botToken, {
        channel: job.slack_channel_id,
        text: "這張圖生成失敗了，要不要換個描述再試一次？",
        thread_ts: job.slack_thread_ts,
      });
      return true;
    }

    return false; // 還在處理
  } catch {
    return false;
  }
}

async function saveUserMemory(params: {
  agentKey: string;
  userMessage: string;
  slackTeamId: string;
  slackChannelId: string;
  slackUserId: string;
}) {
  const {
    getOrCreateAgentConversationThread,
    saveAgentConversationMessage,
  } = await import("@/lib/agent-conversations");

  const ctx = {
    source: "slack",
    projectKey: "brain_router",
    slackTeamId: params.slackTeamId,
    slackChannelId: params.slackChannelId,
    slackUserId: params.slackUserId,
    agentKey: params.agentKey,
  };

  const thread = await getOrCreateAgentConversationThread(ctx);

  await saveAgentConversationMessage({
    threadId: thread.id,
    agentKey: params.agentKey,
    role: "user",
    content: params.userMessage,
    context: ctx,
  });
}

async function saveAssistantMemory(job: any, content: string) {
  const {
    getOrCreateAgentConversationThread,
    saveAgentConversationMessage,
  } = await import("@/lib/agent-conversations");

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
    role: "assistant",
    content,
    context: ctx,
  });
}

// 入口:Slack 收到生圖請求時呼叫(跑在背景)
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

  // 1. 記下使用者訊息(對話記憶)
  await saveUserMemory({
    agentKey,
    userMessage,
    slackTeamId,
    slackChannelId,
    slackUserId,
  });

  // 2. 檢查 Magnific 連線
  const connection = await getActiveMagnificConnection({
    slackTeamId,
    slackUserId,
  });

  if (!connection) {
    const url = getMagnificConnectUrl({ slackTeamId, slackUserId });
    await postToSlack(botToken, {
      channel: slackChannelId,
      text: `要我用 Magnific 幫你生圖之前，先點這裡連接你的 Magnific 帳號：\n${url}\n連好後再跟我說一次要做什麼就好。`,
      thread_ts: slackThreadTs,
    });
    return;
  }

  // 3. 先回「生成中」
  await postToSlack(botToken, {
    channel: slackChannelId,
    text: "🎨 收到，開始生成了，完成後我會把圖貼上來。",
    thread_ts: slackThreadTs,
  });

  // 4. 啟動生成,拿 creation_id
  let creationId: string | null = null;
  try {
    const accessToken = await getValidMagnificAccessToken(connection);
    creationId = await startMagnificGeneration(accessToken, userMessage);
  } catch (error: any) {
    await postToSlack(botToken, {
      channel: slackChannelId,
      text: `開始生成時出錯了：${error?.message || "未知錯誤"}`,
      thread_ts: slackThreadTs,
    });
    return;
  }

  if (!creationId) {
    await postToSlack(botToken, {
      channel: slackChannelId,
      text: "我沒能成功啟動生成（沒拿到任務識別碼）。再試一次或換個描述看看？",
      thread_ts: slackThreadTs,
    });
    return;
  }

  // 5. 建立 job
  const { data: job } = await supabaseAdmin
    .from("magnific_jobs")
    .insert({
      agent_key: agentKey,
      creation_id: creationId,
      user_input: userMessage,
      status: "pending",
      slack_team_id: slackTeamId,
      slack_channel_id: slackChannelId,
      slack_user_id: slackUserId,
      slack_thread_ts: slackThreadTs || null,
    })
    .select("*")
    .single();

  if (!job) return;

  // 6. 就地輪詢約 45 秒(多數圖會在此完成,直接貼出)
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    await sleep(5000);
    const finished = await processMagnificJob(job);
    if (finished) return;
  }

  // 7. 還沒好 → 留著 job,交給 cron poller,並告知使用者
  await postToSlack(botToken, {
    channel: slackChannelId,
    text: "這張比較花時間，還在生成中…好了我會自動貼上來。",
    thread_ts: slackThreadTs,
  });
}
