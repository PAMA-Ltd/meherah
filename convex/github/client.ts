"use node";

import { sign } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { repositoryInstallation } from "./connections";

/**
 * GitHub REST client, authenticated as the GitHub App installation.
 * Node runtime because the app JWT needs an RS256 signature.
 *
 * This is the transport half of the sync layer: convex/github/sync.ts owns
 * all database reads/writes; this file only talks HTTP. Future automations
 * (two-way sync, branch creation, commit linking) add an action here plus a
 * recording mutation there.
 */

function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString(
    "base64url"
  );
}

/** Short-lived JWT identifying the GitHub App (RS256, private key from env). */
function appJwt(): string {
  const appId = process.env.GITHUB_APP_ID;
  // The PEM survives env storage three ways: raw multiline, literal \n
  // escapes, or base64 of the whole file (single line, shell-safe).
  let privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  if (privateKey && !privateKey.includes("-----BEGIN")) {
    privateKey = Buffer.from(privateKey, "base64").toString("utf8");
  }
  if (!appId || !privateKey.includes("-----BEGIN")) {
    throw new Error(
      "GITHUB_APP_ID / GITHUB_PRIVATE_KEY are not set (or the key is not a valid PEM / base64 PEM) on the Convex deployment"
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId })
  );
  const signature = base64url(
    sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)
  );
  return `${header}.${payload}.${signature}`;
}

async function githubFetch<T>(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "meherah-issue-tracker",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub ${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  // DELETE and some PUTs return 204 with an empty body.
  return (text ? JSON.parse(text) : undefined) as T;
}

// ponytail: a fresh installation token per call (2 requests/op, tokens are
// valid 1h) - cache them in a table if rate limits ever bite.
async function installationToken(installationId: number): Promise<string> {
  const data = await githubFetch<{ token: string }>(
    appJwt(),
    "POST",
    `/app/installations/${installationId}/access_tokens`
  );
  return data.token;
}

type GithubRepo = {
  full_name: string;
  name: string;
  private: boolean;
  owner: { login: string } | null;
};

export const repositoryValidator = v.object({
  fullName: v.string(),
  owner: v.string(),
  name: v.string(),
  private: v.boolean(),
});

async function fetchInstallationRepos(
  installationId: number
): Promise<GithubRepo[]> {
  const token = await installationToken(installationId);
  const repositories: GithubRepo[] = [];
  for (let page = 1; ; page++) {
    const data = await githubFetch<{ repositories?: GithubRepo[] }>(
      token, "GET", `/installation/repositories?per_page=100&page=${page}`
    );
    const batch = data.repositories ?? [];
    repositories.push(...batch);
    if (batch.length < 100) return repositories;
  }
}

/**
 * Live list of repositories the org's installation can access - powers the
 * repo pickers. Auth: resolved from the caller's Clerk identity.
 */
type RepositoryInfo = {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
};

export const listRepositories = action({
  args: {},
  returns: v.array(repositoryValidator),
  handler: async (ctx): Promise<RepositoryInfo[]> => {
    const { installations } = await ctx.runQuery(
      internal.github.sync.getAuthedInstallation,
      {}
    );
    const batches = await Promise.all(installations.map(installation => fetchInstallationRepos(installation.installationId)));
    const repositories = new Map(batches.flat().map(repo => [repo.full_name.toLowerCase(), repo]));
    return [...repositories.values()].map((repo) => ({
      fullName: repo.full_name,
      owner: repo.owner?.login ?? repo.full_name.split("/")[0],
      name: repo.name,
      private: repo.private,
    })).sort((a, b) => a.fullName.localeCompare(b.fullName));
  },
});

/**
 * Pull the installation's repo list from the API and store it, instead of
 * waiting for the installation webhook - which races with completeSetup and
 * is dropped if it arrives before the integration row exists (leaving the
 * settings repo list stuck "Syncing…"). Scheduled on connect and callable
 * from the settings page to self-heal an already-connected workspace.
 */
export const syncRepositories = internalAction({
  args: { installationId: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const repos = await fetchInstallationRepos(args.installationId);
      await ctx.runMutation(internal.github.sync.storeRepositories, {
        installationId: args.installationId,
        repositories: repos.map((repo) => repo.full_name).sort(),
      });
    } catch (error) {
      console.error("GitHub repository sync failed", error);
    }
    return null;
  },
});

/** Admin-triggered repo re-sync from the settings page. */
export const refreshRepositories = action({
  args: { installationId: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { installations } = await ctx.runQuery(
      internal.github.sync.getAuthedInstallation,
      { installationId: args.installationId, includeDisabled: true }
    );
    const errors: string[] = [];
    for (const { installationId } of installations) {
      try {
        const repos = await fetchInstallationRepos(installationId);
        await ctx.runMutation(internal.github.sync.storeRepositories, {
          installationId, repositories: repos.map((repo) => repo.full_name).sort(),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length) throw new Error(errors.join("; "));
    return null;
  },
});

function issueBody(description: string | undefined, identifier: string) {
  return `${description ?? ""}\n\n---\n_Synced from Meherah issue **${identifier}**._`;
}

/** Create the GitHub twin of a Meherah issue and record the link. */
export const pushIssue = internalAction({
  args: { issueId: v.id("issues"), repo: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.github.sync.getIssueForSync, {
      issueId: args.issueId,
    });
    if (!info) {
      return null; // integration disconnected or issue deleted since scheduling
    }
    try {
      const installation = repositoryInstallation(info.installations, args.repo);
      if (!installation) throw new Error("Repository is not accessible through an enabled GitHub connection");
      const token = await installationToken(installation.installationId);
      const created = await githubFetch<{ number: number; html_url: string }>(
        token,
        "POST",
        `/repos/${args.repo}/issues`,
        {
          title: info.title,
          body: issueBody(info.description, info.identifier),
        }
      );
      await ctx.runMutation(internal.github.sync.recordGithubIssue, {
        orgId: info.orgId,
        issueId: args.issueId,
        repo: args.repo,
        number: created.number,
        url: created.html_url,
      });
    } catch (error) {
      await ctx.runMutation(internal.github.sync.recordSyncFailure, {
        orgId: info.orgId,
        issueId: args.issueId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  },
});

/**
 * Mirror the current title/description/status onto every linked GitHub
 * issue. Pushes the full state, so rapid successive edits are idempotent -
 * the last scheduled push wins.
 */
export const pushIssueUpdate = internalAction({
  args: { issueId: v.id("issues") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.github.sync.getIssueForSync, {
      issueId: args.issueId,
    });
    if (!info || info.links.length === 0) {
      return null;
    }
    const tokens = new Map<number, string>();
    const closed = info.status === "done" || info.status === "canceled";
    for (const link of info.links) {
      try {
        const token = tokens.get(link.installationId) ?? await installationToken(link.installationId);
        tokens.set(link.installationId, token);
        await githubFetch(
          token,
          "PATCH",
          `/repos/${link.repo}/issues/${link.number}`,
          {
            title: info.title,
            body: issueBody(info.description, info.identifier),
            state: closed ? "closed" : "open",
            ...(closed
              ? {
                  state_reason:
                    info.status === "done" ? "completed" : "not_planned",
                }
              : {}),
          }
        );
      } catch (error) {
        await ctx.runMutation(internal.github.sync.recordSyncFailure, {
          orgId: info.orgId, issueId: args.issueId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  },
});

/** Surface a Meherah attachment on the linked GitHub issue(s) as a comment. */
export const pushAttachmentComment = internalAction({
  args: {
    issueId: v.id("issues"),
    attachmentId: v.id("attachments"),
    fileName: v.string(),
    url: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.github.sync.getIssueForSync, {
      issueId: args.issueId,
    });
    if (!info || info.links.length === 0) {
      return null;
    }
    const tokens = new Map<number, string>();
    for (const link of info.links) {
      try {
        const token = tokens.get(link.installationId) ?? await installationToken(link.installationId);
        tokens.set(link.installationId, token);
        const comment = await githubFetch<{ id: number }>(
          token,
          "POST",
          `/repos/${link.repo}/issues/${link.number}/comments`,
          {
            body: `📎 Attachment added in Meherah: [${args.fileName}](${args.url})`,
          }
        );
        // Remember the comment so removing the attachment can delete it.
        await ctx.runMutation(internal.github.sync.recordAttachmentComment, {
          orgId: info.orgId,
          issueId: args.issueId,
          attachmentId: args.attachmentId,
          repo: link.repo,
          commentId: comment.id,
        });
      } catch (error) {
        await ctx.runMutation(internal.github.sync.recordSyncFailure, {
          orgId: info.orgId, issueId: args.issueId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  },
});

/** Delete the GitHub comments that mirrored a removed Meherah attachment. */
export const deleteAttachmentComments = internalAction({
  args: {
    issueId: v.id("issues"),
    comments: v.array(v.object({ repo: v.string(), commentId: v.number() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.github.sync.getIssueForSync, {
      issueId: args.issueId,
    });
    if (!info) {
      return null;
    }
    const tokens = new Map<number, string>();
    for (const comment of args.comments) {
      const installation = repositoryInstallation(info.installations, comment.repo);
      if (!installation) continue;
      try {
        const token = tokens.get(installation.installationId) ?? await installationToken(installation.installationId);
        tokens.set(installation.installationId, token);
        try {
          await githubFetch(
            token,
            "DELETE",
            `/repos/${comment.repo}/issues/comments/${comment.commentId}`
          );
        } catch (error) {
          // Already deleted on GitHub is fine; anything else surfaces.
          if (!(error instanceof Error && error.message.includes("(404)"))) {
            throw error;
          }
        }
      } catch (error) {
        await ctx.runMutation(internal.github.sync.recordSyncFailure, {
          orgId: info.orgId, issueId: args.issueId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  },
});
