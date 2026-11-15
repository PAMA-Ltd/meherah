import { expect, test } from "vitest";
import { authorizationScopes } from "./lib/mcpScopes";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

test.each([["mcp:read"], ["mcp:write"], []])("grants read and write for a new approval requesting %j", (...requested) => {
  expect(authorizationScopes(requested)).toEqual(["mcp:read", "mcp:write"]);
});

test("preserves offline access and deduplicates the granted scopes", () => {
  expect(authorizationScopes(["mcp:read", "offline_access", "mcp:read"])).toEqual([
    "mcp:read", "mcp:write", "offline_access",
  ]);
});

test("keeps the consent page and its confirmation scope stable", () => {
  const consent = authorizationScopes(["mcp:read", "offline_access"]);
  expect(authorizationScopes(consent)).toEqual(consent);
});

test("issues read/write credentials after a new approval while preserving older read-only grants", async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: "scope-user", name: "Owner", email: "owner@example.test",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "scope-org", slug: "workspace", name: "Workspace", plan: "enterprise",
    });
    await ctx.db.insert("members", {
      orgId, userId, role: "admin", clerkMembershipId: "scope-membership",
    });
    return { userId, orgId };
  });
  const authed = t.withIdentity({ subject: "scope-user", org_id: "scope-org" });
  const clientId = "mhr_client_" + "x".repeat(43);
  const redirectUri = "https://client.example/oauth/callback";
  await t.mutation(api.mcp.registerOAuthClient, { clientId, redirectUris: [redirectUri] });
  const approval = {
    codeHash: "a".repeat(64), clientId, redirectUri,
    codeChallenge: "x".repeat(43), resource: "https://meherah.example/api/mcp",
    scopes: ["mcp:read"],
  };
  await expect(authed.mutation(api.mcp.issueOAuthCode, {
    ...approval, scopes: ["unsupported"],
  })).rejects.toThrow("Unsupported OAuth scope");
  await authed.mutation(api.mcp.issueOAuthCode, approval);
  const token = await t.mutation(internal.mcpData.exchangeOAuthCode, {
    codeHash: approval.codeHash, clientId, redirectUri, codeChallenge: approval.codeChallenge,
    accessTokenHash: "b".repeat(64), accessTokenPrefix: "mhr_mcp_test",
    refreshTokenHash: "c".repeat(64),
  });
  expect(token.scopes).toEqual(["mcp:read", "mcp:write"]);

  await t.run(ctx => ctx.db.insert("mcpCredentials", {
    ...ids, name: "Existing read-only connection", tokenHash: "d".repeat(64),
    tokenPrefix: "mhr_mcp_old", scopes: ["mcp:read"], oauthClientId: clientId,
    refreshTokenHash: "e".repeat(64), expiresAt: Date.now() + 3600000,
  }));
  const refreshed = await t.mutation(internal.mcpData.refreshOAuthCredential, {
    currentRefreshTokenHash: "e".repeat(64), clientId,
    accessTokenHash: "f".repeat(64), accessTokenPrefix: "mhr_mcp_refreshed",
    refreshTokenHash: "0".repeat(64),
  });
  expect(refreshed.scopes).toEqual(["mcp:read"]);
}, 30000);
