import { supabaseAdmin } from "./supabase/server";

export type AgentConversationContext = {
  agentKey: string;
  projectKey?: string;
  source?: string;

  slackTeamId?: string | null;
  slackChannelId?: string | null;
  slackUserId?: string | null;
  slackThreadTs?: string | null;
  slackCommand?: string | null;
  slackResponseUrl?: string | null;

  title?: string | null;
  metadata?: Record<string, any>;
};

function valueOrManual(value?: string | null) {
  return value || "manual";
}

function getThreadKey(ctx: AgentConversationContext) {
  return (
    ctx.slackThreadTs ||
    `agent:${ctx.agentKey}:team:${valueOrManual(
      ctx.slackTeamId
    )}:channel:${valueOrManual(ctx.slackChannelId)}:user:${valueOrManual(
      ctx.slackUserId
    )}`
  );
}

export async function getOrCreateAgentConversationThread(
  ctx: AgentConversationContext
) {
  const projectKey = ctx.projectKey || "brain_router";
  const source = ctx.source || "slack";

  const slackTeamId = valueOrManual(ctx.slackTeamId);
  const slackChannelId = valueOrManual(ctx.slackChannelId);
  const slackUserId = valueOrManual(ctx.slackUserId);
  const slackThreadTs = getThreadKey(ctx);

  const { data: existingThread, error: findError } = await supabaseAdmin
    .from("agent_conversation_threads")
    .select("*")
    .eq("agent_key", ctx.agentKey)
    .eq("project_key", projectKey)
    .eq("source", source)
    .eq("slack_team_id", slackTeamId)
    .eq("slack_channel_id", slackChannelId)
    .eq("slack_user_id", slackUserId)
    .eq("slack_thread_ts", slackThreadTs)
    .maybeSingle();

  if (findError) {
    throw new Error(`Find conversation thread error: ${findError.message}`);
  }

  if (existingThread) {
    return existingThread;
  }

  const { data: newThread, error: insertError } = await supabaseAdmin
    .from("agent_conversation_threads")
    .insert({
      agent_key: ctx.agentKey,
      project_key: projectKey,
      source,
      slack_team_id: slackTeamId,
      slack_channel_id: slackChannelId,
      slack_user_id: slackUserId,
      slack_thread_ts: slackThreadTs,
      title: ctx.title || `${ctx.agentKey} conversation`,
      metadata: ctx.metadata || {},
    })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(`Create conversation thread error: ${insertError.message}`);
  }

  return newThread;
}

export async function saveAgentConversationMessage(params: {
  threadId: string;
  agentKey: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  context?: AgentConversationContext;
  metadata?: Record<string, any>;
}) {
  const ctx = params.context;

  const { error } = await supabaseAdmin
    .from("agent_conversation_messages")
    .insert({
      thread_id: params.threadId,
      agent_key: params.agentKey,
      project_key: ctx?.projectKey || "brain_router",
      source: ctx?.source || "slack",
      role: params.role,
      content: params.content,
      slack_team_id: valueOrManual(ctx?.slackTeamId),
      slack_channel_id: valueOrManual(ctx?.slackChannelId),
      slack_user_id: valueOrManual(ctx?.slackUserId),
      slack_command: ctx?.slackCommand || null,
      slack_response_url: ctx?.slackResponseUrl || null,
      metadata: params.metadata || {},
    });

  if (error) {
    throw new Error(`Save conversation message error: ${error.message}`);
  }

  await supabaseAdmin
    .from("agent_conversation_threads")
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.threadId);
}

export async function getAgentConversationMessages(threadId: string) {
  const { data, error } = await supabaseAdmin
    .from("agent_conversation_messages")
    .select("role, content, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Get conversation messages error: ${error.message}`);
  }

  return data || [];
}

export function formatAgentConversationMessages(
  messages: { role: string; content: string; created_at?: string }[]
) {
  if (!messages.length) {
    return "目前沒有過去對話。";
  }

  return messages
    .map((message) => {
      const speaker =
        message.role === "user"
          ? "使用者"
          : message.role === "assistant"
          ? "Eric Agent"
          : message.role;

      return `${speaker}：\n${message.content}`;
    })
    .join("\n\n---\n\n");
}
