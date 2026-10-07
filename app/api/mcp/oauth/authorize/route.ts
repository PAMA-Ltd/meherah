import { createHash, randomBytes } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = new Set(["mcp:read", "mcp:write"]);

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parsedScopes(value: string | null) {
  const scopes = (value ?? "mcp:read mcp:write")
    .split(/\s+/)
    .filter(Boolean);
  if (scopes.length === 0 || scopes.some((scope) => !SCOPES.has(scope))) {
    throw new Error("Unsupported OAuth scope");
  }
  return [...new Set(scopes)];
}

type RequestFields = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string;
  scopes: string[];
};

async function validate(
  requestUrl: string,
  fields: {
    responseType: string | null;
    clientId: string | null;
    redirectUri: string | null;
    codeChallenge: string | null;
    codeChallengeMethod: string | null;
    state: string | null;
    resource: string | null;
    scope: string | null;
  }
): Promise<RequestFields> {
  const origin = new URL(requestUrl).origin;
  if (
    fields.responseType !== "code" ||
    !fields.clientId ||
    !fields.redirectUri ||
    !fields.codeChallenge ||
    fields.codeChallengeMethod !== "S256" ||
    !fields.state ||
    fields.resource !== origin + "/api/mcp"
  ) {
    throw new Error("Invalid OAuth authorization request");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(fields.codeChallenge)) {
    throw new Error("Invalid PKCE challenge");
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error("Convex is not configured");
  const client = new ConvexHttpClient(convexUrl);
  const registered = await client.query(api.mcp.getOAuthClient, {
    clientId: fields.clientId,
  });
  if (!registered || !registered.redirectUris.includes(fields.redirectUri)) {
    throw new Error("Unknown OAuth client or redirect URI");
  }

  const scopes = parsedScopes(fields.scope);
  return {
    clientId: fields.clientId,
    redirectUri: fields.redirectUri,
    codeChallenge: fields.codeChallenge,
    state: fields.state,
    resource: fields.resource,
    scope: scopes.join(" "),
    scopes,
  };
}

function html(fields: RequestFields, workspaceName?: string) {
  const inputs = [
    ["client_id", fields.clientId],
    ["redirect_uri", fields.redirectUri],
    ["code_challenge", fields.codeChallenge],
    ["state", fields.state],
    ["resource", fields.resource],
    ["scope", fields.scope],
  ]
    .map(
      ([name, value]) =>
        '<input type="hidden" name="' +
        name +
        '" value="' +
        escapeHtml(value) +
        '" />'
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Connect ChatGPT to Meherah</title>
</head>
<body style="margin:0;background:#0a0a0a;color:#fafafa;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px">
  <main style="width:min(480px,100%);border:1px solid #2a2a2a;border-radius:16px;padding:28px;background:#111">
    <div style="font-size:13px;color:#a3a3a3;margin-bottom:8px">Meherah MCP</div>
    <h1 style="font-size:24px;margin:0 0 12px">Connect ChatGPT?</h1>
    <p style="line-height:1.6;color:#d4d4d4;margin:0 0 18px">
      ChatGPT will be able to read and update the active Meherah workspace${workspaceName ? " <strong>" + escapeHtml(workspaceName) + "</strong>" : ""}.
      Access can be revoked later from Meherah.
    </p>
    <p style="font-size:13px;color:#a3a3a3;margin:0 0 22px">
      Requested permissions: ${escapeHtml(fields.scope)}
    </p>
    <form method="post">
      ${inputs}
      <button type="submit" style="width:100%;border:0;border-radius:10px;padding:12px 16px;font-weight:700;cursor:pointer">
        Authorize ChatGPT
      </button>
    </form>
  </main>
</body>
</html>`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const fields = await validate(request.url, {
      responseType: url.searchParams.get("response_type"),
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
      codeChallenge: url.searchParams.get("code_challenge"),
      codeChallengeMethod: url.searchParams.get("code_challenge_method"),
      state: url.searchParams.get("state"),
      resource: url.searchParams.get("resource"),
      scope: url.searchParams.get("scope"),
    });
    const session = await auth();
    if (!session.userId || !session.orgId) {
      return Response.json(
        { error: "An active Meherah workspace is required" },
        { status: 401 }
      );
    }
    return new Response(html(fields), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid authorization request";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const form = new URLSearchParams(await request.text());
    const fields = await validate(request.url, {
      responseType: "code",
      clientId: form.get("client_id"),
      redirectUri: form.get("redirect_uri"),
      codeChallenge: form.get("code_challenge"),
      codeChallengeMethod: "S256",
      state: form.get("state"),
      resource: form.get("resource"),
      scope: form.get("scope"),
    });

    const session = await auth();
    if (!session.userId || !session.orgId) {
      return Response.json(
        { error: "An active Meherah workspace is required" },
        { status: 401 }
      );
    }
    const jwt = await session.getToken({ template: "convex" });
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!jwt || !convexUrl) throw new Error("Meherah auth is not configured");

    const code = "mhr_code_" + randomBytes(32).toString("base64url");
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(jwt);
    await client.mutation(api.mcp.issueOAuthCode, {
      codeHash: hash(code),
      clientId: fields.clientId,
      redirectUri: fields.redirectUri,
      codeChallenge: fields.codeChallenge,
      resource: fields.resource,
      scopes: fields.scopes,
    });

    const redirect = new URL(fields.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", fields.state);
    return Response.redirect(redirect, 302);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authorization failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
