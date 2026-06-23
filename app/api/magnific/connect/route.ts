import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  buildMagnificAuthorizeUrl,
  createCodeChallenge,
  createCodeVerifier,
  createOAuthState,
} from "@/lib/tools/magnific/oauth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    const slackTeamId = url.searchParams.get("slack_team_id") || "manual";
    const slackUserId = url.searchParams.get("slack_user_id") || "manual";
    const redirectAfter = url.searchParams.get("redirect_after") || "";

    const state = createOAuthState();
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error } = await supabaseAdmin.from("tool_oauth_states").insert({
      provider: "magnific",
      agent_key: "eric",
      state,
      slack_team_id: slackTeamId,
      slack_user_id: slackUserId,
      redirect_after: redirectAfter,
      expires_at: expiresAt,
      metadata: {
        code_verifier: codeVerifier,
      },
    });

    if (error) {
      throw new Error(`Supabase insert state error: ${error.message}`);
    }

    const authorizeUrl = buildMagnificAuthorizeUrl({
      state,
      codeChallenge,
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message || "Unknown error",
      },
      { status: 500 }
    );
  }
}
