import { convexTest } from "convex-test";
import { expect, test, vi, afterEach, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: "clerk-user", name: "Owner", email: "owner@example.test",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "clerk-org", slug: "workspace", name: "Workspace", plan: "enterprise",
    });
    const membershipId = await ctx.db.insert("members", {
      orgId, userId, role: "admin", clerkMembershipId: "clerk-membership",
    });
    const otherOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "other-clerk-org", name: "Other", plan: "free",
    });
    const orgConnection = await ctx.db.insert("integrations", {
      orgId, type: "github", enabled: true, connectedBy: userId,
      installationId: 101, repositories: ["company/app"],
    });
    return { userId, orgId, otherOrgId, orgConnection, membershipId };
  });
  const authed = t.withIdentity({ subject: "clerk-user", org_id: "clerk-org" });
  const addPersonal = () => t.run(ctx => ctx.db.insert("integrations", {
    orgId: ids.orgId, type: "github", enabled: true, connectedBy: ids.userId,
    installationId: 202, repositories: ["personal/tools"],
  }));
  return { t, authed, ids, addPersonal };
}

async function linkedIssue(t, ids) {
  return t.run(async ctx => {
    const teamId = await ctx.db.insert("teams", {
      orgId: ids.orgId, name: "Engineering", key: "ENG", nextIssueNumber: 2,
    });
    const issueId = await ctx.db.insert("issues", {
      orgId: ids.orgId, teamId, number: 1, title: "Bug", status: "todo",
      priority: "none", sortOrder: 1, creatorId: ids.userId,
    });
    for (const [repo, number] of [["company/app", 11], ["personal/tools", 22]]) {
      await ctx.db.insert("githubIssues", {
        orgId: ids.orgId, issueId, repo, number, url: `https://github.com/${repo}/issues/${number}`,
      });
    }
    return issueId;
  });
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function mockGithub(respond) {
  vi.stubEnv("GITHUB_APP_ID", "1234");
  vi.stubEnv("GITHUB_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }));
  const requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const request = { path: new URL(url).pathname, url, ...options };
    requests.push(request);
    const token = request.path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (token) return Response.json({ token: `token-${token[1]}` });
    return respond(request);
  }));
  return requests;
}

test("adding a personal installation keeps the organization's existing binding", async () => {
  const { t, ids } = await fixture();
  await t.run(ctx => ctx.db.insert("githubInstallStates", {
    orgId: ids.orgId, userId: ids.userId, nonce: "new-account",
  }));
  await t.mutation(internal.integrations.completeSetup, {
    nonce: "new-account", installationId: 202,
  });
  const rows = await t.run(ctx => ctx.db.query("integrations").collect());
  expect(rows.map(row => row.installationId).sort()).toEqual([101, 202]);
});

test("workspace settings combine repositories and expose both connections", async () => {
  const { authed, addPersonal } = await fixture();
  await addPersonal();
  const result = await authed.query(api.integrations.get, {});
  expect(result.connection.repositories).toEqual(["company/app", "personal/tools"]);
  expect(result.connections.map(row => row.installationId).sort()).toEqual([101, 202]);
});

test("disabling one installation leaves the other active", async () => {
  const { t, authed, addPersonal } = await fixture();
  await addPersonal();
  await authed.mutation(api.integrations.setEnabled, { enabled: false, installationId: 202 });
  const result = await authed.query(api.integrations.get, {});
  expect(result.connection.repositories).toEqual(["company/app"]);
  expect(await t.run(ctx => ctx.db.query("integrations").collect())).toMatchObject([
    { installationId: 101, enabled: true }, { installationId: 202, enabled: false },
  ]);
});

test("disconnecting one installation keeps the other account connected", async () => {
  const { authed, addPersonal } = await fixture();
  await addPersonal();
  await authed.mutation(api.integrations.disconnect, { installationId: 202 });
  expect((await authed.query(api.integrations.get, {})).connection.repositories).toEqual(["company/app"]);
});

test("installations bound to another workspace cannot be claimed", async () => {
  const { t, ids } = await fixture();
  await t.run(async ctx => {
    await ctx.db.insert("integrations", {
      orgId: ids.otherOrgId, type: "github", enabled: true, connectedBy: ids.userId,
      installationId: 303, repositories: ["other/private"],
    });
    await ctx.db.insert("githubInstallStates", {
      orgId: ids.orgId, userId: ids.userId, nonce: "other-account",
    });
  });
  await expect(t.mutation(internal.integrations.completeSetup, {
    nonce: "other-account", installationId: 303,
  })).rejects.toThrow(/another workspace/i);
});

test("account controls reject an installation from another workspace", async () => {
  const { authed } = await fixture();
  await expect(authed.mutation(api.integrations.disconnect, { installationId: 999 }))
    .rejects.toThrow(/not found/i);
});

test("a webhook uninstall removes only the affected account", async () => {
  const { t, authed, addPersonal } = await fixture();
  await addPersonal();
  await t.mutation(internal.integrations.handleInstallationEvent, { installationId: 202, action: "deleted" });
  expect((await authed.query(api.integrations.get, {})).connection.repositories).toEqual(["company/app"]);
});

test("outbound sync chooses each repository's installation", async () => {
  const { t, ids, addPersonal } = await fixture();
  await addPersonal();
  const issueId = await t.run(async ctx => {
    const teamId = await ctx.db.insert("teams", {
      orgId: ids.orgId, name: "Engineering", key: "ENG", nextIssueNumber: 2,
    });
    const issueId = await ctx.db.insert("issues", {
      orgId: ids.orgId, teamId, number: 1, title: "Bug", status: "todo",
      priority: "none", sortOrder: 1, creatorId: ids.userId,
    });
    await ctx.db.insert("githubIssues", {
      orgId: ids.orgId, issueId, repo: "company/app", number: 11, url: "https://github.com/company/app/issues/11",
    });
    await ctx.db.insert("githubIssues", {
      orgId: ids.orgId, issueId, repo: "personal/tools", number: 22, url: "https://github.com/personal/tools/issues/22",
    });
    return issueId;
  });
  const result = await t.query(internal.github.sync.getIssueForSync, { issueId });
  expect(result.links).toMatchObject([
    { repo: "company/app", installationId: 101 },
    { repo: "personal/tools", installationId: 202 },
  ]);
});

test("reconnecting the same account is idempotent and preserves repositories", async () => {
  const { t, ids, authed } = await fixture();
  await t.run(ctx => ctx.db.insert("githubInstallStates", {
    orgId: ids.orgId, userId: ids.userId, nonce: "reconnect",
  }));
  expect(await t.mutation(internal.integrations.completeSetup, {
    nonce: "reconnect", installationId: 101,
  })).toBe("workspace");
  const result = await authed.query(api.integrations.get, {});
  expect(result.connections).toHaveLength(1);
  expect(result.connection.repositories).toEqual(["company/app"]);
  expect(await t.mutation(internal.integrations.completeSetup, {
    nonce: "reconnect", installationId: 202,
  })).toBeNull();
});

test("expired connect requests do not replace or add accounts", async () => {
  const { t, ids, authed } = await fixture();
  await t.run(ctx => ctx.db.insert("githubInstallStates", {
    orgId: ids.orgId, userId: ids.userId, nonce: "expired",
  }));
  vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  expect(await t.mutation(internal.integrations.completeSetup, {
    nonce: "expired", installationId: 202,
  })).toBeNull();
  expect((await authed.query(api.integrations.get, {})).connections).toHaveLength(1);
});

test("a revoked admin cannot finish connecting another account", async () => {
  const { t, ids } = await fixture();
  await t.run(async ctx => {
    await ctx.db.insert("githubInstallStates", {
      orgId: ids.orgId, userId: ids.userId, nonce: "revoked",
    });
    await ctx.db.patch(ids.membershipId, { role: "member" });
  });
  await expect(t.mutation(internal.integrations.completeSetup, {
    nonce: "revoked", installationId: 202,
  })).rejects.toThrow(/admin access required/i);
});

test("repository discovery combines all pages from both accounts using their own tokens", async () => {
  const { authed, addPersonal } = await fixture();
  await addPersonal();
  const requests = mockGithub(request => {
    const page = Number(new URL(request.url).searchParams.get("page"));
    const owner = request.headers.Authorization === "Bearer token-101" ? "company" : "personal";
    const names = owner === "company" && page === 1
      ? Array.from({ length: 100 }, (_, i) => `repo-${i}`)
      : owner === "company" ? ["last-repo"] : ["tools"];
    return Response.json({ repositories: names.map(name => ({
      full_name: `${owner}/${name}`, name, private: true, owner: { login: owner },
    })) });
  });
  const repositories = await authed.action(api.github.client.listRepositories, {});
  expect(repositories).toHaveLength(102);
  expect(repositories.map(repo => repo.fullName)).toContain("company/last-repo");
  expect(repositories.map(repo => repo.fullName)).toContain("personal/tools");
  expect(requests.filter(request => request.path === "/installation/repositories")
    .map(request => request.headers.Authorization).sort())
    .toEqual(["Bearer token-101", "Bearer token-101", "Bearer token-202"]);
});

test("outbound HTTP updates use the correct account and continue after one account fails", async () => {
  const { t, ids, addPersonal } = await fixture();
  await addPersonal();
  const issueId = await linkedIssue(t, ids);
  const requests = mockGithub(request => request.path.startsWith("/repos/company/")
    ? Response.json({ message: "Unavailable" }, { status: 503 })
    : Response.json({}));
  await t.action(internal.github.client.pushIssueUpdate, { issueId });
  expect(requests.filter(request => request.method === "PATCH").map(request => ({
    path: request.path, token: request.headers.Authorization,
  }))).toEqual([
    { path: "/repos/company/app/issues/11", token: "Bearer token-101" },
    { path: "/repos/personal/tools/issues/22", token: "Bearer token-202" },
  ]);
  expect(await t.run(ctx => ctx.db.query("activity").collect()))
    .toMatchObject([{ type: "github_sync_failed" }]);
});

test("disabled accounts are excluded from outbound sync and repository discovery", async () => {
  const { t, ids, authed, addPersonal } = await fixture();
  await addPersonal();
  const issueId = await linkedIssue(t, ids);
  await authed.mutation(api.integrations.setEnabled, { installationId: 202, enabled: false });
  expect((await t.query(internal.github.sync.getIssueForSync, { issueId })).links)
    .toMatchObject([{ repo: "company/app", installationId: 101 }]);
  const requests = mockGithub(() => Response.json({ repositories: [] }));
  await authed.action(api.github.client.listRepositories, {});
  expect(requests.some(request => request.path.includes("/202/"))).toBe(false);
});

test("non-admins cannot refresh installation metadata", async () => {
  const { t, ids, authed } = await fixture();
  await t.run(ctx => ctx.db.patch(ids.membershipId, { role: "member" }));
  await expect(authed.action(api.github.client.refreshRepositories, { installationId: 101 }))
    .rejects.toThrow(/admin access required/i);
});
