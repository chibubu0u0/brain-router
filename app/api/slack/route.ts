import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import crypto from "crypto";
import {
  runBrainRouter,
  runDirectAgentWithConversation,
} from "@/lib/brain-router";

export const runtime = "nodejs";
export const maxDuration = 60;

function verifySlackSignature(rawBody: string, req: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    throw new Error("Missing SLACK_SIGNING_SECRET");
  }

  const timestamp = req.headers.get("x-slack-request-timestamp");
  const slackSignature = req.headers.get("x-slack-signature");

  if (!timestamp || !slackSignature) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const requestTime = Number(timestamp);

  if (Math.abs(now - requestTime) > 60 * 5) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;

  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(baseString)
      .digest("hex");

  const a = Buffer.from(mySignature);
  const b = Buffer.from(slackSignature);

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function getAgentKeyFromCommand(command: string) {
  const map: Record<string, string> = {
    "/ryan": "ryan",
    "/queenie": "queenie",
    "/eric": "eric",
  };

  return map[command] || null;
}

function getAgentDisplayName(agentKey: string) {
  const map: Record<string, string> = {
    ryan: "Ryan Agent",
    queenie: "Queenie Agent",
    eric: "Eric Agent",
  };

  return map[agentKey] || agentKey;
}

async function postToSlack(responseUrl: string, text: string) {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      response_type: "ephemeral",
      text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to post to Slack: ${errorText}`);
  }
}

async function processSlackCommand(params: {
  command: string;
  text: string;
  responseUrl: string;
  slackTeamId: string;
  slackChannelId: string;
  slackUserId: string;
}) {
  const {
    command,
    text,
    responseUrl,
    slackTeamId,
    slackChannelId,
    slackUserId,
  } = params;

  try {
    const agentKey = getAgentKeyFromCommand(command);

    if (agentKey) {
      const result = await runDirectAgentWithConversation(agentKey, text, {
        source: "slack",
        projectKey: "brain_router",
        slackTeamId,
        slackChannelId,
        slackUserId,
        slackCommand: command,
        slackResponseUrl: responseUrl,
      });

      await postToSlack(responseUrl, result.finalAnswer);
      return;
    }

    const result = await runBrainRouter(text);
    await postToSlack(responseUrl, result.finalAnswer);
  } catch (error: any) {
    await postToSlack(
      responseUrl,
      `Brain Router 發生錯誤：${error.message || "Unknown error"}`
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    const isValid = verifySlackSignature(rawBody, req);

    if (!isValid) {
      return NextResponse.json(
        {
          response_type: "ephemeral",
          text: "Slack request verification failed.",
        },
        { status: 401 }
      );
    }

    const params = new URLSearchParams(rawBody);

    const command = params.get("command") || "/brain";
    const text = params.get("text")?.trim() || "";
    const responseUrl = params.get("response_url");

    const slackTeamId = params.get("team_id") || "manual";
    const slackChannelId = params.get("channel_id") || "manual";
    const slackUserId = params.get("user_id") || "manual";

    if (!text) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: `請在 \`${command}\` 後面輸入內容，例如：\`${command} 這個方向你怎麼看？\``,
      });
    }

    if (!responseUrl) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: "Slack 沒有提供 response_url，無法延後回覆。",
      });
    }

    waitUntil(
      processSlackCommand({
        command,
        text,
        responseUrl,
        slackTeamId,
        slackChannelId,
        slackUserId,
      })
    );

    const agentKey = getAgentKeyFromCommand(command);

    if (agentKey) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: `收到，我正在直接詢問 ${getAgentDisplayName(
          agentKey
        )}，並讀取這個 Agent 的完整對話紀錄。\n\n問題：${text}`,
      });
    }

    return NextResponse.json({
      response_type: "ephemeral",
      text: `收到，我正在請 Brain Router 判斷需要詢問哪些 expert brain。\n\n問題：${text}`,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        response_type: "ephemeral",
        text: `Brain Router 發生錯誤：${error.message || "Unknown error"}`,
      },
      { status: 500 }
    );
  }
}
