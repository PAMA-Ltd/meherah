import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

const SCOPES = new Set(["mcp:read", "mcp:write"]);

export type OAuthAuthorizationFields = {
  clientId: string;
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
  const requestedScopes = (value(params, "scope") ?? "mcp:read mcp:write")
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
    resource !== origin + "/api/mcp"
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
  if (!registered || !registered.redirectUris.includes(redirectUri)) {
    throw new Error("Unknown OAuth client or redirect URI");
  }

  return {
    clientId,
    redirectUri,
    codeChallenge,
    state,
    resource,
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
