import crypto from "crypto";
import { after, NextRequest, NextResponse } from "next/server";
import {
  runBrainRouter,
  runDirectAgentWithConversation,
} from "@/lib/brain-router";

export const runtime = "nodejs";
export const maxDuration = 300;

const DISCORD_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_PONG = 1;
const DISCORD_CHANNEL_MESSAGE = 4;
const DISCORD_DEFERRED_CHANNEL_MESSAGE = 5;
const DISCORD_EPHEMERAL = 1 << 6;
const DISCORD_MESSAGE_LIMIT = 1900;

type DiscordOption = {
  name: string;
  value?: string;
  options?: DiscordOption[];
};

type DiscordInteraction = {
  type: number;
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: {
    name?: string;
    options?: DiscordOption[];
  };
};

function getDiscordPublicKey() {
  return process.env.DISCORD_PUBLIC_KEY?.trim() || "";
}

function verifyDiscordSignature(rawBody: string, req: NextRequest) {
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  const publicKeyHex = getDiscordPublicKey();

  if (!signature || !timestamp || !publicKeyHex) return false;

  try {
    // Discord 提供的是 32-byte raw Ed25519 public key；Node crypto 需要
    // SubjectPublicKeyInfo DER，前綴是 Ed25519 固定標頭。
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });

    return crypto.verify(
      null,
      Buffer.from(timestamp + rawBody),
      publicKey,
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

function findStringOption(
  options: DiscordOption[] | undefined,
  name: string
): string {
  for (const option of options || []) {
    if (option.name === name && typeof option.value === "string") {
      return option.value.trim();
    }

    const nested: string = findStringOption(option.options, name);
    if (nested) return nested;
  }

  return "";
}

function splitDiscordMessage(text: string) {
  const content = text.trim() || "（沒有可顯示的回覆）";
  if (content.length <= DISCORD_MESSAGE_LIMIT) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n", DISCORD_MESSAGE_LIMIT);
    if (splitAt < DISCORD_MESSAGE_LIMIT / 2) {
      splitAt = DISCORD_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function discordWebhookRequest(params: {
  applicationId: string;
  interactionToken: string;
  method: "PATCH" | "POST";
  path: string;
  content: string;
}) {
  const url = `https://discord.com/api/v10/webhooks/${params.applicationId}/${params.interactionToken}${params.path}`;
  const response = await fetch(url, {
    method: params.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: params.content }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord webhook error ${response.status}: ${errorText}`);
  }
}

async function replyToDiscord(
  applicationId: string,
  interactionToken: string,
  text: string
) {
  const chunks = splitDiscordMessage(text);

  await discordWebhookRequest({
    applicationId,
    interactionToken,
    method: "PATCH",
    path: "/messages/@original",
    content: chunks[0],
  });

  for (const chunk of chunks.slice(1)) {
    await discordWebhookRequest({
      applicationId,
      interactionToken,
      method: "POST",
      path: "",
      content: chunk,
    });
  }
}

async function processDiscordCommand(params: {
  command: string;
  message: string;
  applicationId: string;
  interactionToken: string;
  guildId: string;
  channelId: string;
  userId: string;
}) {
  const {
    command,
    message,
    applicationId,
    interactionToken,
    guildId,
    channelId,
    userId,
  } = params;

  try {
    const agentKey = ["eric", "ryan", "queenie"].includes(command)
      ? command
      : null;

    const answer = agentKey
      ? (
          await runDirectAgentWithConversation(agentKey, message, {
            source: "discord",
            projectKey: "brain_router",
            // 現有資料表沿用舊欄位名稱；加上 discord: 前綴避免與
            // Slack ID 相撞，source 也會明確標記為 discord。
            slackTeamId: `discord:${guildId}`,
            slackChannelId: `discord:${channelId}`,
            slackUserId: `discord:${userId}`,
            slackCommand: `/${command}`,
            metadata: { discordGuildId: guildId, discordChannelId: channelId },
          })
        ).finalAnswer
      : (await runBrainRouter(message)).finalAnswer;

    await replyToDiscord(applicationId, interactionToken, answer);
  } catch (error: unknown) {
    const messageText =
      error instanceof Error ? error.message : "Unknown error";

    try {
      await replyToDiscord(
        applicationId,
        interactionToken,
        `發生錯誤：${messageText}`
      );
    } catch (replyError) {
      console.error("Failed to report Discord interaction error", replyError);
    }
  }
}

export async function POST(req: NextRequest) {
  if (!getDiscordPublicKey()) {
    return NextResponse.json(
      { error: "Server missing DISCORD_PUBLIC_KEY" },
      { status: 503 }
    );
  }

  const rawBody = await req.text();

  if (!verifyDiscordSignature(rawBody, req)) {
    return NextResponse.json({ error: "invalid request signature" }, { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (interaction.type === DISCORD_PING) {
    return NextResponse.json({ type: DISCORD_PONG });
  }

  if (interaction.type !== DISCORD_APPLICATION_COMMAND) {
    return NextResponse.json(
      {
        type: DISCORD_CHANNEL_MESSAGE,
        data: { content: "目前只支援 slash commands。", flags: DISCORD_EPHEMERAL },
      }
    );
  }

  const command = interaction.data?.name?.toLowerCase() || "";
  const message = findStringOption(interaction.data?.options, "message");
  const applicationId =
    interaction.application_id || process.env.DISCORD_APPLICATION_ID || "";
  const interactionToken = interaction.token || "";
  const guildId = interaction.guild_id || "dm";
  const channelId = interaction.channel_id || "dm";
  const userId = interaction.member?.user?.id || interaction.user?.id || "unknown";

  if (!["brain", "eric", "ryan", "queenie"].includes(command)) {
    return NextResponse.json({
      type: DISCORD_CHANNEL_MESSAGE,
      data: { content: "不認得這個指令。", flags: DISCORD_EPHEMERAL },
    });
  }

  if (!message || !applicationId || !interactionToken) {
    return NextResponse.json({
      type: DISCORD_CHANNEL_MESSAGE,
      data: {
        content: "請在 message 欄位輸入想說的內容。",
        flags: DISCORD_EPHEMERAL,
      },
    });
  }

  after(() =>
    processDiscordCommand({
      command,
      message,
      applicationId,
      interactionToken,
      guildId,
      channelId,
      userId,
    })
  );

  return NextResponse.json({ type: DISCORD_DEFERRED_CHANNEL_MESSAGE });
}
