// =====================================================================
// Slack Events API 入口(支援 @mention 與私訊 DM)
// 放到:app/api/agents/[agent]/events/route.ts
//
// 設計:多個 Agent 共用這一支程式。
// Slack 事件網址用 .../api/agents/eric/events、.../api/agents/ryan/events ...
// 程式用網址裡的 agent 名字,去環境變數拿對應的 signing secret 與 bot token。
//
// 加新 Agent 時:不用改這支程式,只要在 Vercel 加對應的環境變數即可。
// =====================================================================

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import crypto from "crypto";
import { runDirectAgentWithConversation } from "@/lib/brain-router";

export const runtime = "nodejs";
// Magnific 生成與狀態輪詢可能超過一分鐘。Vercel Hobby 在 Fluid Compute
// 下可執行最多 300 秒；waitUntil 會沿用這個上限。
export const maxDuration = 300;

// 每個 Agent 對應自己 Slack App 的環境變數名稱
const AGENT_SLACK_ENV: Record<
  string,
  { signingSecret: string; botToken: string }
> = {
  eric: {
    signingSecret: "SLACK_ERIC_SIGNING_SECRET",
    botToken: "SLACK_ERIC_BOT_TOKEN",
  },
  ryan: {
    signingSecret: "SLACK_RYAN_SIGNING_SECRET",
    botToken: "SLACK_RYAN_BOT_TOKEN",
  },
  queenie: {
    signingSecret: "SLACK_QUEENIE_SIGNING_SECRET",
    botToken: "SLACK_QUEENIE_BOT_TOKEN",
  },
};

function getAgentSlackConfig(agentKey: string) {
  const map = AGENT_SLACK_ENV[agentKey];
  if (!map) return null;

  const signingSecret = process.env[map.signingSecret];
  const botToken = process.env[map.botToken];

  if (!signingSecret || !botToken) return null;

  return { signingSecret, botToken };
}

function verifySlackSignature(
  rawBody: string,
  req: NextRequest,
  signingSecret: string
) {
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const slackSignature = req.headers.get("x-slack-signature");

  if (!timestamp || !slackSignature) return false;

  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(baseString)
      .digest("hex");

  const a = Buffer.from(mySignature);
  const b = Buffer.from(slackSignature);

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

// 把訊息裡的 <@U123> 這種 mention 拿掉,只留下純文字
function stripMentions(text: string) {
  return text
    .replace(/<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function postMessage(
  botToken: string,
  params: { channel: string; text: string; thread_ts?: string }
) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Slack chat.postMessage error: ${data.error}`);
  }
}

async function processEvent(
  agentKey: string,
  botToken: string,
  event: any,
  teamId: string
) {
  const channel = event.channel;
  const userMessage = stripMentions(event.text || "");

  if (!userMessage) return;

  // 回覆位置:
  // - 頂層 @ 或 DM(本來就沒有 thread_ts)→ 直接平鋪在頻道/對話裡,像聊天室。
  // - 只有當使用者本來就在某個對話串裡 @ 他,才回在那個串裡。
  const replyThreadTs = event.thread_ts;

  // 生圖請求 → 走「背景生圖」流程(它自己會回生成中、輪詢、完成後貼圖)
  const wantsMagnific = agentKey === "eric" && /magnific/i.test(userMessage);

  if (wantsMagnific) {
    try {
      const { handleMagnificRequest } = await import(
        "@/lib/tools/magnific/generate"
      );

      await handleMagnificRequest({
        agentKey,
        userMessage,
        botToken,
        slackTeamId: teamId,
        slackChannelId: channel,
        slackUserId: event.user,
        slackThreadTs: replyThreadTs,
      });
    } catch (error: any) {
      await postMessage(botToken, {
        channel,
        text: `發生錯誤：${error.message || "Unknown error"}`,
        thread_ts: replyThreadTs,
      });
    }
    return;
  }

  try {
    const result = await runDirectAgentWithConversation(agentKey, userMessage, {
      source: "slack",
      projectKey: "brain_router",
      slackTeamId: teamId,
      slackChannelId: channel,
      slackUserId: event.user,
      // 注意:這裡「故意不傳 slackThreadTs」。
      // 記憶會以「頻道 + 使用者」為單位(見 agent-conversations 的 getThreadKey),
      // 所以你在同一個地方跟 Eric 講的話都算同一條連續對話,
      // 不管你是發新訊息、還是在 thread 裡回覆,他都記得。
      slackCommand: `@${agentKey}`,
    });

    await postMessage(botToken, {
      channel,
      text: result.finalAnswer,
      thread_ts: replyThreadTs,
    });
  } catch (error: any) {
    await postMessage(botToken, {
      channel,
      text: `發生錯誤：${error.message || "Unknown error"}`,
      thread_ts: replyThreadTs,
    });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agent: string }> }
) {
  const { agent } = await params;
  const agentKey = agent.toLowerCase();

  const rawBody = await req.text();

  let body: any;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // 1. Slack 第一次設定 Event URL 時的驗證挑戰
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // 2. 取得這個 agent 的密鑰(沒設定就擋掉)
  const config = getAgentSlackConfig(agentKey);

  if (!config) {
    return NextResponse.json(
      { error: "unknown agent or missing env" },
      { status: 404 }
    );
  }

  // 3. 驗證 Slack 簽章
  if (!verifySlackSignature(rawBody, req, config.signingSecret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  // 4. Slack 失敗時會重送同一個事件,直接略過避免重複回覆
  if (req.headers.get("x-slack-retry-num")) {
    return new NextResponse(null, { status: 200 });
  }

  const event = body.event;

  // 5. 只處理「使用者的 @mention」與「私訊 DM」。
  //    忽略 bot 自己發的訊息與編輯/刪除等 subtype,避免無限迴圈。
  const isUserMessage =
    event &&
    (event.type === "app_mention" ||
      (event.type === "message" && event.channel_type === "im")) &&
    !event.bot_id &&
    !event.subtype;

  if (isUserMessage) {
    waitUntil(processEvent(agentKey, config.botToken, event, body.team_id));
  }

  // 6. 一律快速回 200(Slack 要求 3 秒內回應,實際工作在背景跑)
  return new NextResponse(null, { status: 200 });
}
