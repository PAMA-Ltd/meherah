import { randomBytes } from "crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { isAllowedRedirectUri } from "@/convex/lib/mcpRedirects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: {
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "Invalid JSON" },
      { status: 400 }
    );
  }

  if (
    !Array.isArray(body.redirect_uris) ||
    body.redirect_uris.length === 0 ||
    body.redirect_uris.some((uri) => typeof uri !== "string")
  ) {
    return Response.json(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array of URLs",
      },
      { status: 400 }
    );
  }
  if (
    body.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== "none"
  ) {
    return Response.json(
      {
        error: "invalid_client_metadata",
        error_description: "Meherah MCP uses public PKCE OAuth clients",
      },
      { status: 400 }
    );
  }

  const redirectUris = body.redirect_uris as string[];
  const unsupported = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
  if (unsupported) {
    return Response.json(
      {
        error: "invalid_redirect_uri",
        error_description:
          `Unsupported redirect_uri: ${unsupported}. Register either an ` +
          "https://chatgpt.com/connector/... callback or a loopback callback " +
          "such as http://127.0.0.1/callback or http://localhost:<port>/callback.",
      },
      { status: 400 }
    );
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  const clientId = "mhr_client_" + randomBytes(32).toString("base64url");
  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim()
      : "MCP client";
  try {
    const client = new ConvexHttpClient(convexUrl);
    await client.mutation(api.mcp.registerOAuthClient, {
      clientId,
      clientName,
      redirectUris,
    });
    return Response.json(
      {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Client registration failed";
    return Response.json(
      { error: "invalid_client_metadata", error_description: message },
      { status: 400 }
    );
  }
}
