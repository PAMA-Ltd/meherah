import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { anyRedirectUriMatches } from "@/convex/lib/mcpRedirects";

const SCOPES = new Set(["mcp:read", "mcp:write", "offline_access"]);

export type OAuthAuthorizationFields = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string;
  scopes: string[];
};

function value(params: URLSearchParams, key: string) {
  const item = params.get(key);
  return item && item.trim() ? item : null;
}

export async function validateOAuthAuthorization(
  origin: string,
  params: URLSearchParams
): Promise<OAuthAuthorizationFields> {
  const responseType = value(params, "response_type");
  const clientId = value(params, "client_id");
  const redirectUri = value(params, "redirect_uri");
  const codeChallenge = value(params, "code_challenge");
  const codeChallengeMethod = value(params, "code_challenge_method");
  const state = value(params, "state");
  const resource = value(params, "resource");
  // MCP hosts vary in whether they send `resource` (RFC 8707). The value is
  // recorded as an audience hint and never re-checked after consent, so an
  // absent value falls back to this deployment's single canonical resource
  // while an explicitly mismatched one is still rejected.
  const expectedResource = origin + "/api/mcp";
  const requestedScopes = (value(params, "scope") ?? "mcp:read mcp:write offline_access")
    .split(/\s+/)
    .filter(Boolean);
  const scopes = [...new Set(requestedScopes)];

  if (
    responseType !== "code" ||
    !clientId ||
    !redirectUri ||
    !codeChallenge ||
    codeChallengeMethod !== "S256" ||
    !state ||
    (resource !== null && resource !== expectedResource)
  ) {
    throw new Error("Invalid OAuth authorization request");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new Error("Invalid PKCE challenge");
  }
  if (scopes.length === 0 || scopes.some((scope) => !SCOPES.has(scope))) {
    throw new Error("Unsupported OAuth scope");
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error("Convex is not configured");
  const client = new ConvexHttpClient(convexUrl);
  const registered = await client.query(api.mcp.getOAuthClient, { clientId });
  if (!registered || !anyRedirectUriMatches(registered.redirectUris, redirectUri)) {
    throw new Error("Unknown OAuth client or redirect URI");
  }

  return {
    clientId,
    clientName: registered.clientName ?? "MCP client",
    redirectUri,
    codeChallenge,
    state,
    resource: resource ?? expectedResource,
    scope: scopes.join(" "),
    scopes,
  };
}

export function hiddenOAuthFields(fields: OAuthAuthorizationFields) {
  return {
    response_type: "code",
    client_id: fields.clientId,
    redirect_uri: fields.redirectUri,
    code_challenge: fields.codeChallenge,
    code_challenge_method: "S256",
    state: fields.state,
    resource: fields.resource,
    scope: fields.scope,
  };
}
