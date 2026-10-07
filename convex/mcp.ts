import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { embedText } from "./agent/embeddings";
import {
  AI_NOT_CONFIGURED_MESSAGE,
  embeddingScope,
  isAiConfigured,
} from "./agent/models";

const READ_OPERATIONS = new Set([
  "get_profile",
  "list_teams",
  "list_members",
  "list_issues",
  "search_issues",
  "get_issue",
  "list_comments",
  "list_labels",
  "list_projects",
  "get_project",
  "project_summary",
  "list_cycles",
  "get_cycle",
  "cycle_summary",
  "list_issue_relations",
  "workspace_summary",
]);

const WRITE_OPERATIONS = new Set([
  "create_team",
  "create_issue",
  "update_issue",
  "assign_issue",
  "set_issue_status",
  "set_issue_priority",
  "set_issue_estimate",
  "set_issue_due_date",
  "delete_issue",
  "create_comment",
  "update_comment",
  "delete_comment",
  "create_label",
  "add_issue_label",
  "remove_issue_label",
  "create_project",
  "update_project",
  "delete_project",
  "create_cycle",
  "update_cycle",
  "delete_cycle",
  "create_issue_relation",
  "delete_issue_relation",
  "set_issue_parent",
]);

const MCP_SCOPES = new Set(["mcp:read", "mcp:write", "offline_access"]);

function validChatGptRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      (url.pathname.startsWith("/connector/oauth/") ||
        url.pathname === "/connector_platform_oauth_redirect")
    );
  } catch {
    return false;
  }
}

function normalizeScopes(scopes: string[]): string[] {
  const unique = [...new Set(scopes)];
  if (
    unique.length === 0 ||
    unique.some((scope) => !MCP_SCOPES.has(scope))
  ) {
    throw new ConvexError("Unsupported OAuth scope");
  }
  return unique;
}

function base64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const value = (a << 16) | (b << 8) | c;
    output += alphabet[(value >> 18) & 63];
    output += alphabet[(value >> 12) & 63];
    if (i + 1 < bytes.length) output += alphabet[(value >> 6) & 63];
    if (i + 2 < bytes.length) output += alphabet[value & 63];
  }
  return output;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64Url(new Uint8Array(digest));
}

export const registerOAuthClient = mutation({
  args: {
    clientId: v.string(),
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    if (
      !/^mhr_client_[A-Za-z0-9_-]{32,}$/.test(args.clientId) ||
      args.redirectUris.length === 0 ||
      args.redirectUris.length > 10 ||
      args.redirectUris.some((uri) => !validChatGptRedirect(uri))
    ) {
      throw new ConvexError("Invalid ChatGPT OAuth client registration");
    }
    const existing = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing) throw new ConvexError("OAuth client already exists");
    await ctx.db.insert("mcpOAuthClients", {
      clientId: args.clientId,
      clientName: args.clientName?.slice(0, 120),
      redirectUris: [...new Set(args.redirectUris)],
    });
    return args.clientId;
  },
});

export const getOAuthClient = query({
  args: { clientId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      clientId: v.string(),
      clientName: v.union(v.string(), v.null()),
      redirectUris: v.array(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!client) return null;
    return {
      clientId: client.clientId,
      clientName: client.clientName ?? null,
      redirectUris: client.redirectUris,
    };
  },
});

export const issueOAuthCode = orgMutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    resource: v.string(),
    scopes: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      !/^[a-f0-9]{64}$/.test(args.codeHash) ||
      !/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge)
    ) {
      throw new ConvexError("Invalid OAuth authorization request");
    }
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!client || !client.redirectUris.includes(args.redirectUri)) {
      throw new ConvexError("OAuth client or redirect URI is invalid");
    }
    const scopes = normalizeScopes(args.scopes);
    const existing = await ctx.db
      .query("mcpOAuthCodes")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", args.codeHash))
      .unique();
    if (existing) throw new ConvexError("Authorization code already exists");
    await ctx.db.insert("mcpOAuthCodes", {
      codeHash: args.codeHash,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      resource: args.resource,
      scopes,
      orgId: ctx.org._id,
      userId: ctx.user._id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return null;
  },
});

export const exchangeOAuthCode = action({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeVerifier: v.string(),
    accessTokenHash: v.string(),
    accessTokenPrefix: v.string(),
    refreshTokenHash: v.string(),
  },
  returns: v.object({
    scopes: v.array(v.string()),
    expiresIn: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ scopes: string[]; expiresIn: number }> => {
    if (args.codeVerifier.length < 43 || args.codeVerifier.length > 128) {
      throw new ConvexError("Invalid PKCE verifier");
    }
    const codeChallenge = await pkceChallenge(args.codeVerifier);
    return await ctx.runMutation(internal.mcpData.exchangeOAuthCode, {
      codeHash: args.codeHash,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      codeChallenge,
      accessTokenHash: args.accessTokenHash,
      accessTokenPrefix: args.accessTokenPrefix,
      refreshTokenHash: args.refreshTokenHash,
    });
  },
});

export const refreshOAuthCredential = action({
  args: {
    currentRefreshTokenHash: v.string(),
    clientId: v.string(),
    accessTokenHash: v.string(),
    accessTokenPrefix: v.string(),
    refreshTokenHash: v.string(),
  },
  returns: v.object({
    scopes: v.array(v.string()),
    expiresIn: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ scopes: string[]; expiresIn: number }> => {
    return await ctx.runMutation(internal.mcpData.refreshOAuthCredential, args);
  },
});

export const revokeOAuthToken = mutation({
  args: { tokenHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    let credential = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!credential) {
      credential = await ctx.db
        .query("mcpCredentials")
        .withIndex("by_refresh_token_hash", (q) =>
          q.eq("refreshTokenHash", args.tokenHash)
        )
        .unique();
    }
    if (!credential) return false;
    if (credential.revokedAt === undefined) {
      await ctx.db.patch(credential._id, { revokedAt: Date.now() });
    }
    return true;
  },
});

export const createCredential = orgMutation({
  args: {
    name: v.string(),
    tokenHash: v.string(),
    tokenPrefix: v.string(),
    expiresAt: v.optional(v.number()),
  },
  returns: v.id("mcpCredentials"),
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name || name.length > 80) {
      throw new ConvexError("Credential name must be 1-80 characters");
    }
    if (!/^[a-f0-9]{64}$/.test(args.tokenHash)) {
      throw new ConvexError("Invalid credential hash");
    }
    if (args.tokenPrefix.length < 8 || args.tokenPrefix.length > 24) {
      throw new ConvexError("Invalid credential prefix");
    }
    if (args.expiresAt !== undefined && args.expiresAt <= Date.now()) {
      throw new ConvexError("Credential expiry must be in the future");
    }
    const existing = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (existing) throw new ConvexError("Credential already exists");
    return await ctx.db.insert("mcpCredentials", {
      orgId: ctx.org._id,
      userId: ctx.user._id,
      name,
      tokenHash: args.tokenHash,
      tokenPrefix: args.tokenPrefix,
      expiresAt: args.expiresAt,
    });
  },
});

export const listCredentials = orgQuery({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("mcpCredentials"),
      name: v.string(),
      tokenPrefix: v.string(),
      createdAt: v.number(),
      lastUsedAt: v.union(v.number(), v.null()),
      expiresAt: v.union(v.number(), v.null()),
      revokedAt: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx) => {
    const credentials = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", ctx.org._id).eq("userId", ctx.user._id)
      )
      .order("desc")
      .collect();
    return credentials.map((credential) => ({
      id: credential._id,
      name: credential.name,
      tokenPrefix: credential.tokenPrefix,
      createdAt: credential._creationTime,
      lastUsedAt: credential.lastUsedAt ?? null,
      expiresAt: credential.expiresAt ?? null,
      revokedAt: credential.revokedAt ?? null,
    }));
  },
});

export const revokeCredential = orgMutation({
  args: { credentialId: v.id("mcpCredentials") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.credentialId);
    if (
      !credential ||
      credential.orgId !== ctx.org._id ||
      credential.userId !== ctx.user._id
    ) {
      throw new ConvexError("Credential not found");
    }
    if (credential.revokedAt === undefined) {
      await ctx.db.patch(credential._id, { revokedAt: Date.now() });
    }
    return null;
  },
});

export const verifyCredential = action({
  args: { tokenHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const auth = await ctx.runQuery(internal.mcpData.authenticateToken, {
      tokenHash: args.tokenHash,
    });
    return auth !== null;
  },
});

export const execute = action({
  args: {
    tokenHash: v.string(),
    operation: v.string(),
    input: v.any(),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> => {
    const auth = await ctx.runQuery(internal.mcpData.authenticateToken, {
      tokenHash: args.tokenHash,
    });
    if (!auth) {
      throw new ConvexError("Invalid, expired, or revoked MCP credential");
    }
    await ctx.runMutation(internal.mcpData.touchCredential, {
      credentialId: auth.credentialId,
    });

    if (READ_OPERATIONS.has(args.operation)) {
      if (!auth.scopes.includes("mcp:read")) {
        throw new ConvexError("This credential does not grant mcp:read");
      }
      return await ctx.runQuery(internal.mcpData.executeRead, {
        orgId: auth.orgId,
        userId: auth.userId,
        role: auth.role,
        operation: args.operation,
        input: args.input,
      });
    }

    if (WRITE_OPERATIONS.has(args.operation)) {
      if (!auth.scopes.includes("mcp:write")) {
        throw new ConvexError("This credential does not grant mcp:write");
      }
      return await ctx.runMutation(internal.mcpData.executeWrite, {
        orgId: auth.orgId,
        userId: auth.userId,
        role: auth.role,
        operation: args.operation,
        input: args.input,
      });
    }

    if (!auth.scopes.includes("mcp:read")) {
      throw new ConvexError("This credential does not grant mcp:read");
    }

    const input =
      args.input && typeof args.input === "object" && !Array.isArray(args.input)
        ? (args.input as Record<string, unknown>)
        : {};

    if (args.operation === "project_status_report") {
      return await ctx.runQuery(internal.agent.data.listProjectStatus, {
        orgId: auth.orgId,
      });
    }

    if (args.operation === "cycle_summary_for_team") {
      const teamKey = input.teamKey;
      if (typeof teamKey !== "string" || !teamKey.trim()) {
        throw new ConvexError("teamKey is required");
      }
      return await ctx.runQuery(internal.agent.data.cycleSummaryForTeam, {
        orgId: auth.orgId,
        teamKey,
      });
    }

    if (args.operation === "standup_report") {
      const teamKey =
        typeof input.teamKey === "string" ? input.teamKey : undefined;
      const requestedHours =
        typeof input.sinceHours === "number" ? input.sinceHours : 24;
      const sinceHours = Math.min(Math.max(requestedHours, 1), 168);
      return await ctx.runQuery(internal.agent.data.standupForOrg, {
        orgId: auth.orgId,
        teamKey,
        sinceHours,
      });
    }

    if (args.operation === "semantic_search_issues") {
      if (auth.plan === "free") {
        throw new ConvexError(
          "Semantic search requires a Pro or Enterprise workspace"
        );
      }
      if (!isAiConfigured()) {
        throw new ConvexError(AI_NOT_CONFIGURED_MESSAGE);
      }
      const text = input.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new ConvexError("text is required");
      }
      const limit =
        typeof input.limit === "number"
          ? Math.max(1, Math.min(Math.floor(input.limit), 20))
          : 8;
      const embedding = await embedText(text);
      const results = await ctx.vectorSearch("issues", "by_embedding", {
        vector: embedding,
        limit: Math.max(limit, 8),
        filter: (q) => q.eq("embeddingScope", embeddingScope(auth.orgId)),
      });
      const summaries = await ctx.runQuery(
        internal.agent.data.issueSummariesByIds,
        {
          orgId: auth.orgId,
          issueIds: results.map((result) => result._id),
        }
      );
      const scores = new Map(
        results.map((result) => [result._id, result._score])
      );
      return summaries.slice(0, limit).map((summary) => ({
        ...summary,
        similarity:
          Math.round((scores.get(summary.issueId) ?? 0) * 1000) / 1000,
      }));
    }

    throw new ConvexError("Unknown MCP operation: " + args.operation);
  },
});
