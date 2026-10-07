import { createHash, randomBytes } from "crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function token(prefix: string) {
  return prefix + randomBytes(32).toString("base64url");
}

function oauthError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    }
  );
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthError(
      "invalid_request",
      "Token requests must use application/x-www-form-urlencoded"
    );
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return oauthError("server_error", "Convex is not configured", 500);

  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id");
  if (!clientId) return oauthError("invalid_request", "client_id is required");

  const accessToken = token("mhr_access_");
  const refreshToken = token("mhr_refresh_");
  const client = new ConvexHttpClient(convexUrl);

  try {
    if (grantType === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      const codeVerifier = form.get("code_verifier");
      if (!code || !redirectUri || !codeVerifier) {
        return oauthError(
          "invalid_request",
          "code, redirect_uri, and code_verifier are required"
        );
      }
      const result = await client.action(api.mcp.exchangeOAuthCode, {
        codeHash: hash(code),
        clientId,
        redirectUri,
        codeVerifier,
        accessTokenHash: hash(accessToken),
        accessTokenPrefix: accessToken.slice(0, 18),
        refreshTokenHash: hash(refreshToken),
      });
      return Response.json(
        {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: refreshToken,
          scope: result.scopes.join(" "),
        },
        {
          headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          },
        }
      );
    }

    if (grantType === "refresh_token") {
      const currentRefreshToken = form.get("refresh_token");
      if (!currentRefreshToken) {
        return oauthError("invalid_request", "refresh_token is required");
      }
      const result = await client.action(api.mcp.refreshOAuthCredential, {
        currentRefreshTokenHash: hash(currentRefreshToken),
        clientId,
        accessTokenHash: hash(accessToken),
        accessTokenPrefix: accessToken.slice(0, 18),
        refreshTokenHash: hash(refreshToken),
      });
      return Response.json(
        {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: refreshToken,
          scope: result.scopes.join(" "),
        },
        {
          headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          },
        }
      );
    }

    return oauthError("unsupported_grant_type", "Unsupported grant_type");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "OAuth token exchange failed";
    return oauthError("invalid_grant", message);
  }
}
