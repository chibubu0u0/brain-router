import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { exchangeMagnificCode } from "@/lib/tools/magnific/oauth";

export const runtime = "nodejs";

function htmlPage(title: string, body: string) {
  return new NextResponse(
    `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 40px;
        line-height: 1.7;
        color: #111;
      }
      .card {
        max-width: 680px;
        border: 1px solid #ddd;
        border-radius: 16px;
        padding: 28px;
      }
      code {
        background: #f4f4f4;
        padding: 3px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      ${body}
    </div>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    }
  );
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return htmlPage(
        "Magnific 連接失敗",
        `<h1>Magnific 連接失敗</h1><p>${error}</p>`
      );
    }

    if (!code || !state) {
      return htmlPage(
        "Magnific 連接失敗",
        "<h1>Magnific 連接失敗</h1><p>缺少 code 或 state。</p>"
      );
    }

    const { data: oauthState, error: stateError } = await supabaseAdmin
      .from("tool_oauth_states")
      .select("*")
      .eq("state", state)
      .single();

    if (stateError || !oauthState) {
      throw new Error("OAuth state not found.");
    }

    if (oauthState.used_at) {
      throw new Error("OAuth state already used.");
    }

    if (new Date(oauthState.expires_at).getTime() < Date.now()) {
      throw new Error("OAuth state expired.");
    }

    const codeVerifier = oauthState.metadata?.code_verifier;

    if (!codeVerifier) {
      throw new Error("Missing code verifier.");
    }

    const tokenData = await exchangeMagnificCode({
      code,
      codeVerifier,
    });

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    const slackTeamId = oauthState.slack_team_id || "manual";
    const slackUserId = oauthState.slack_user_id || "manual";

    const { data: existingConnection } = await supabaseAdmin
      .from("tool_connections")
      .select("*")
      .eq("provider", "magnific")
      .eq("agent_key", "eric")
      .eq("slack_team_id", slackTeamId)
      .eq("slack_user_id", slackUserId)
      .maybeSingle();

    if (existingConnection) {
      const { error: updateError } = await supabaseAdmin
        .from("tool_connections")
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || existingConnection.refresh_token,
          token_type: tokenData.token_type || "Bearer",
          scope: tokenData.scope || "",
          expires_at: expiresAt,
          status: "active",
          metadata: {
            magnific_user: tokenData.id_token ? "connected" : "connected",
          },
          updated_at: new Date().toISOString(),
          last_connected_at: new Date().toISOString(),
        })
        .eq("id", existingConnection.id);

      if (updateError) {
        throw new Error(`Update connection error: ${updateError.message}`);
      }
    } else {
      const { error: insertError } = await supabaseAdmin
        .from("tool_connections")
        .insert({
          provider: "magnific",
          agent_key: "eric",
          slack_team_id: slackTeamId,
          slack_user_id: slackUserId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || null,
          token_type: tokenData.token_type || "Bearer",
          scope: tokenData.scope || "",
          expires_at: expiresAt,
          status: "active",
          metadata: {
            magnific_user: tokenData.id_token ? "connected" : "connected",
          },
        });

      if (insertError) {
        throw new Error(`Insert connection error: ${insertError.message}`);
      }
    }

    await supabaseAdmin
      .from("tool_oauth_states")
      .update({
        used_at: new Date().toISOString(),
      })
      .eq("id", oauthState.id);

    return htmlPage(
      "Magnific 已連接",
      `<h1>Magnific 已成功連接</h1>
       <p>Eric Agent 現在可以使用 Magnific MCP。</p>
       <p>你可以回到 Slack 測試：</p>
       <p><code>/eric magnific 幫我生成一張序日製作所主視覺</code></p>`
    );
  } catch (error: any) {
    return htmlPage(
      "Magnific 連接失敗",
      `<h1>Magnific 連接失敗</h1>
       <p>${error.message || "Unknown error"}</p>`
    );
  }
}
