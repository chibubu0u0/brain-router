// =====================================================================
// Magnific 背景生圖(兩段式 + 輪詢)— 除錯強化版
// 放到:lib/tools/magnific/generate.ts(覆蓋現有)
//
// 這版的重點:把「工具實際回報的錯誤」攤出來,不再吞掉。
// - 啟動生成時若 images_generate 報錯 → 直接把真錯誤回 Slack。
// - 查狀態時若工具報錯 → 連同真錯誤一起回,並寫進 job.error_message。
// =====================================================================

import { supabaseAdmin } from "@/lib/supabase/server";
import {
  getActiveMagnificConnection,
  getValidMagnificAccessToken,
  getMagnificConnectUrl,
} from "./mcp";

const ERIC_BOT_TOKEN_ENV = "SLACK_ERIC_BOT_TOKEN";
const OPENAI_MCP_TIMEOUT_MS = 90_000;
const INLINE_POLL_WINDOW_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;

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
  // 常見 MCP 錯誤結構:{type, content:[{type:'text', text}]}
  if (Array.isArray(error?.content)) {
    return error.content.map((c: any) => c?.text || "").filter(Boolean).join(" ");
  }
  return JSON.stringify(error);
}

// 從回應裡撈出所有 mcp_call(名稱、輸出、錯誤)
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

// 呼叫 OpenAI Responses + Magnific MCP 工具,回傳最終文字 + 工具呼叫明細
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
    allowed_tools: [
      "images_generate",
      "creation_status",
      "creations_get",
      "creations_wait",
    ],
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

// 啟動生成,拿 creation_id(不等完成)。若工具報錯就 throw 真錯誤。
export async function startMagnificGeneration(
  accessToken: string,
  prompt: string
): Promise<string | null> {
  const system = `你可以使用 Magnific 工具。
請呼叫 images_generate 開始生成圖片，「不要」等它完成。
呼叫完成後，只回一個 JSON：{"creation_id":"<images_generate 回傳的識別碼>"}
不要任何多餘文字。`;

  const { text, calls } = await magnificModelCall(
    accessToken,
    system,
    `生成這張圖：${prompt}`
  );

  // 工具層真的報錯 → 直接拋出真錯誤
  const errs = calls
    .filter((c) => c.error)
    .map((c) => `${c.name}: ${errToStr(c.error)}`);
  if (errs.length > 0) {
    throw new Error(errs.join("; "));
  }

  // 先信模型整理的 JSON,拿不到再從 images_generate 的原始輸出找識別碼
  const json = parseFirstJson(text);
  let id: string | null = json?.creation_id || null;

  if (!id) {
    const gen = calls.find((c) => c.name === "images_generate");
    if (gen) {
      const gj = parseFirstJson(gen.output);
      id =
        gj?.identifier ||
        gj?.id ||
        gj?.creationIdentifier ||
        gj?.creation_id ||
        null;
    }
  }

  return id;
}

// 查狀態。回傳 status / imageUrl / detail(真錯誤或說明)
export async function checkMagnificStatus(
  accessToken: string,
  creationId: string
): Promise<{
  status: "processing" | "done" | "error";
  imageUrl: string;
  webUrl: string;
  detail: string;
}> {
  const system = `你可以使用 Magnific 工具。請取得識別碼 ${creationId} 的「最終圖片」。
做法(依序嘗試):
1. 優先用 creations_wait，參數 identifiers: ["${creationId}"]（它會等到完成並回傳最終資產)。
2. 或用 creations_get，參數 creationIdentifier: "${creationId}"。
3. 從結果取兩種網址:
   - image_url:可直接顯示的圖片檔網址(url / originalUrl / previewUrl)。
   - web_url:這個 creation 在 Magnific 的可開啟頁面連結(webUrl / 分享連結)。
重要:只有當 Magnific 明確表示這個 creation「失敗」時，才回 status:"error"；
若還在處理中、或你暫時拿不到網址但它沒失敗，請回 status:"processing"（不要當成失敗）。
只回一個 JSON：{"status":"processing|done|error","image_url":"<圖片檔網址，沒有就空>","web_url":"<Magnific 頁面連結，沒有就空>","detail":"<若失敗或異常，放原因>"}
不要任何多餘文字。`;

  const { text, calls } = await magnificModelCall(
    accessToken,
    system,
    `查詢 ${creationId} 的狀態`
  );

  const toolErrs = calls
    .filter((c) => c.error)
    .map((c) => `${c.name}: ${errToStr(c.error)}`);

  const json = parseFirstJson(text);

  // 只有模型明確說 done / error 才採信;否則一律當「還在處理」(避免誤判失敗)
  const status: "processing" | "done" | "error" =
    json?.status === "done" || json?.status === "error"
      ? json.status
      : "processing";

  // 工具報錯只當作除錯線索(放 detail),不直接翻成「生成失敗」
  const detail = json?.detail || toolErrs.join("; ") || "";

  return {
    status,
    imageUrl: json?.image_url || "",
    webUrl: json?.web_url || "",
    detail,
  };
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
    const { status, imageUrl, webUrl, detail } = await checkMagnificStatus(
      accessToken,
      job.creation_id
    );

    if (job.id) {
      await supabaseAdmin
        .from("magnific_jobs")
        .update({ attempts: (job.attempts || 0) + 1, updated_at: new Date().toISOString() })
        .eq("id", job.id);
    }

    // 完成:只要拿到「圖片網址」或「Magnific 頁面連結」其一,就算成功送回
    if (status === "done" && (imageUrl || webUrl)) {
      const resultUrl = imageUrl || webUrl;
      if (job.id) {
        await supabaseAdmin
          .from("magnific_jobs")
          .update({ status: "done", result_url: resultUrl, updated_at: new Date().toISOString() })
          .eq("id", job.id);
      }

      const text = imageUrl
        ? `圖好了 👇\n${imageUrl}${webUrl ? `\n(在 Magnific 開啟:${webUrl})` : ""}`
        : `圖生好了!直接圖檔抓不到,在 Magnific 開啟看／下載 👇\n${webUrl}`;

      await postToSlack(botToken, {
        channel: job.slack_channel_id,
        text,
        thread_ts: job.slack_thread_ts,
      });
      await saveAssistantMemory(job, `圖好了:${resultUrl}`);
      return true;
    }

    // 只有 Magnific 明確說失敗才算失敗;附上 creation id 方便你在作品庫找
    if (status === "error") {
      if (job.id) {
        await supabaseAdmin
          .from("magnific_jobs")
          .update({
            status: "error",
            error_message: detail || "Magnific 回報生成失敗",
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
      }
      await postToSlack(botToken, {
        channel: job.slack_channel_id,
        text:
          (detail
            ? `這張圖生成失敗了。原因:${detail}`
            : "這張圖生成失敗了,要不要換個描述再試一次?") +
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

async function saveUserMemory(params: {
  agentKey: string;
  userMessage: string;
  slackTeamId: string;
  slackChannelId: string;
  slackUserId: string;
}) {
  const { getOrCreateAgentConversationThread, saveAgentConversationMessage } =
    await import("@/lib/agent-conversations");

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
    role: "assistant",
    content,
    context: ctx,
  });
}

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

  await saveUserMemory({
    agentKey,
    userMessage,
    slackTeamId,
    slackChannelId,
    slackUserId,
  });

  const connection = await getActiveMagnificConnection({ slackTeamId, slackUserId });

  if (!connection) {
    const url = getMagnificConnectUrl({ slackTeamId, slackUserId });
    await postToSlack(botToken, {
      channel: slackChannelId,
      text: `要我用 Magnific 幫你生圖之前，先點這裡連接你的 Magnific 帳號：\n${url}\n連好後再跟我說一次要做什麼就好。`,
      thread_ts: slackThreadTs,
    });
    return;
  }

  await postToSlack(botToken, {
    channel: slackChannelId,
    text: "🎨 收到，開始生成了，完成後我會把圖貼上來。",
    thread_ts: slackThreadTs,
  });

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

  const { data: job, error: jobError } = await supabaseAdmin
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

  const trackingJob =
    job || {
      id: null,
      agent_key: agentKey,
      creation_id: creationId,
      slack_team_id: slackTeamId,
      slack_channel_id: slackChannelId,
      slack_user_id: slackUserId,
      slack_thread_ts: slackThreadTs || null,
    };

  if (jobError) {
    console.error("Failed to persist Magnific job", jobError.message);
  }

  const deadline = Date.now() + INLINE_POLL_WINDOW_MS;
  while (Date.now() + POLL_INTERVAL_MS + OPENAI_MCP_TIMEOUT_MS < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const finished = await processMagnificJob(trackingJob);
    if (finished) return;
  }

  await postToSlack(botToken, {
    channel: slackChannelId,
    text: `這張生成比較久,圖正在 Magnific 產出。你現在就能到 Magnific 作品庫看(creation id: ${creationId})。我這邊一拿到完成圖也會盡量補上來。`,
    thread_ts: slackThreadTs,
  });
}
