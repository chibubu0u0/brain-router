import crypto from "crypto";

const AUTHORIZATION_ENDPOINT =
  "https://auth.magnific.com/realms/mcp/protocol/openid-connect/auth";

const TOKEN_ENDPOINT =
  "https://auth.magnific.com/realms/mcp/protocol/openid-connect/token";

export function getMagnificOAuthConfig() {
  const clientId = process.env.MAGNIFIC_CLIENT_ID;
  const clientSecret = process.env.MAGNIFIC_CLIENT_SECRET;
  const redirectUri = process.env.MAGNIFIC_REDIRECT_URI;

  if (!clientId) throw new Error("Missing MAGNIFIC_CLIENT_ID");
  if (!clientSecret) throw new Error("Missing MAGNIFIC_CLIENT_SECRET");
  if (!redirectUri) throw new Error("Missing MAGNIFIC_REDIRECT_URI");

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

export function createOAuthState() {
  return crypto.randomBytes(32).toString("hex");
}

export function createCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

export function createCodeChallenge(codeVerifier: string) {
  return crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
}

export function buildMagnificAuthorizeUrl(params: {
  state: string;
  codeChallenge: string;
}) {
  const { clientId, redirectUri } = getMagnificOAuthConfig();

  const url = new URL(AUTHORIZATION_ENDPOINT);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set(
    "scope",
    "openid profile email basic offline_access mcp:custom-audience"
  );
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

export async function exchangeMagnificCode(params: {
  code: string;
  codeVerifier: string;
}) {
  const { clientId, clientSecret, redirectUri } = getMagnificOAuthConfig();

  const body = new URLSearchParams();

  body.set("grant_type", "authorization_code");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("redirect_uri", redirectUri);
  body.set("code", params.code);
  body.set("code_verifier", params.codeVerifier);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Magnific token exchange failed: ${errorText}`);
  }

  return response.json();
}
