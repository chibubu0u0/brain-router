// =====================================================================
// Magnific MCP 串接模組
// 放到:lib/tools/magnific/mcp.ts
//
// 負責:查連線、取有效 token(過期自動 refresh)、組 OpenAI 的 mcp tool、
//       組「去連接」連結、判斷是否要用 Magnific、紀錄 tool_runs。
// =====================================================================

import { supabaseAdmin } from "@/lib/supabase/server";
import { refreshMagnificToken } from "./oauth";

// 判斷使用者這句是不是想用 Magnific(目前用顯式關鍵字,之後可改成更聰明的意圖判斷)
export function isMagnificIntent(text: string) {
  return /magnific/i.test(text);
}

// 查這個使用者有沒有 active 的 Magnific 連線
export async function getActiveMagnificConnection(params: {
  slackTeamId: string;
  slackUserId: string;
}) {
  const { data } = await supabaseAdmin
    .from("tool_connections")
    .select("*")
    .eq("provider", "magnific")
    .eq("agent_key", "eric")
    .eq("slack_team_id", params.slackTeamId)
    .eq("slack_user_id", params.slackUserId)
    .eq("status", "active")
    .maybeSingle();

  return data || null;
}

// 取得「還有效」的 access token;若快過期且有 refresh_token,就自動換新並寫回 DB
export async function getValidMagnificAccessToken(connection: any) {
  const expiresMs = connection.expires_at
    ? new Date(connection.expires_at).getTime()
    : 0;

  // 還有超過 60 秒才過期 → 直接用
  const stillValid = expiresMs && expiresMs - 60_000 > Date.now();

  if (stillValid) {
    return connection.access_token as string;
  }

  // 沒有 refresh_token,只能賭它還能用
  if (!connection.refresh_token) {
    return connection.access_token as string;
  }

  const tokenData = await refreshMagnificToken(connection.refresh_token);

  const newExpiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  await supabaseAdmin
    .from("tool_connections")
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || connection.refresh_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  return tokenData.access_token as string;
}

// 組成 OpenAI Responses API 要的 remote MCP tool
// 注意:token 放在 authorization 欄位(不是 headers)
export function buildMagnificMcpTool(accessToken: string) {
  return {
    type: "mcp",
    server_label: "magnific",
    server_url: process.env.MAGNIFIC_MCP_SERVER_URL,
    authorization: accessToken,
    require_approval: "never",
    // 想限制 Eric 只能用某些工具時,再打開下面這行並填正確的工具名稱:
    // allowed_tools: ["images_generate", "images_upscale", "images_remove_background"],
  };
}

// 組「去連接 Magnific」的連結(沒連過帳號時回給使用者)
export function getMagnificConnectUrl(params: {
  slackTeamId: string;
  slackUserId: string;
}) {
  const redirect = process.env.MAGNIFIC_REDIRECT_URI || "";
  const base = redirect.replace("/api/magnific/callback", "");

  const url = new URL(`${base}/api/magnific/connect`);
  url.searchParams.set("slack_team_id", params.slackTeamId);
  url.searchParams.set("slack_user_id", params.slackUserId);

  return url.toString();
}

// 紀錄一次 Magnific 任務到 tool_runs(best-effort:失敗不影響回覆)
export async function recordMagnificRun(params: {
  slackTeamId: string;
  slackUserId: string;
  userInput: string;
  status: "success" | "error";
  responseText?: string;
  errorMessage?: string;
}) {
  try {
    await supabaseAdmin.from("tool_runs").insert({
      provider: "magnific",
      agent_key: "eric",
      slack_team_id: params.slackTeamId,
      slack_user_id: params.slackUserId,
      user_input: params.userInput,
      tool_mode: "mcp",
      response_payload: params.responseText
        ? { text: params.responseText }
        : null,
      status: params.status,
      error_message: params.errorMessage || null,
    });
  } catch {
    // tool_runs 欄位若與此不符,僅略過紀錄,不影響使用者體驗
  }
}
