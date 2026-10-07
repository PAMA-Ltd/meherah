import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  MutationCtx,
  QueryCtx,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { scheduleGithubIssueSync } from "./github/sync";
import { getOrgIssue, insertIssue } from "./issues";
import { logActivity } from "./lib/activity";
import {
  autoLinkFigmaUrls,
  scheduleFigmaDevSync,
} from "./lib/figmaLinks";
import { assertCanCreateProject } from "./lib/limits";
import { createNotification } from "./notifications";

type AnyInput = Record<string, unknown>;
type AuthContext = {
  orgId: Id<"organizations">;
  userId: Id<"users">;
  role: "admin" | "member";
};

const ISSUE_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
const ISSUE_PRIORITIES = new Set(["none", "urgent", "high", "medium", "low"]);
const PROJECT_STATUSES = new Set([
  "backlog",
  "planned",
  "in_progress",
  "paused",
  "completed",
  "canceled",
]);
const RELATION_TYPES = new Set([
  "blocks",
  "blocked_by",
  "related",
  "duplicate_of",
]);

function inputObject(value: unknown): AnyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConvexError("Tool arguments must be an object");
  }
  return value as AnyInput;
}

function requiredString(input: AnyInput, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConvexError(key + " is required");
  }
  return value.trim();
}

function optionalString(input: AnyInput, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConvexError(key + " must be a string");
  }
  return value;
}

function requiredNumber(input: AnyInput, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConvexError(key + " must be a number");
  }
  return value;
}

function optionalNumber(input: AnyInput, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConvexError(key + " must be a number");
  }
  return value;
}

function optionalNullableNumber(
  input: AnyInput,
  key: string
): number | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConvexError(key + " must be a number or null");
  }
  return value;
}

function optionalNullableString(
  input: AnyInput,
  key: string
): string | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new ConvexError(key + " must be a string or null");
  }
  return value;
}

function stringArray(input: AnyInput, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConvexError(key + " must be an array of strings");
  }
  return value as string[];
}

function boundedLimit(input: AnyInput, fallback = 50): number {
  const value = optionalNumber(input, "limit") ?? fallback;
  return Math.max(1, Math.min(Math.floor(value), 100));
}

async function resolveTeamByKey(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  teamKey: string
): Promise<Doc<"teams">> {
  const team = await ctx.db
    .query("teams")
    .withIndex("by_org_and_key", (q) =>
      q.eq("orgId", orgId).eq("key", teamKey.toUpperCase().trim())
    )
    .unique();
  if (!team) throw new ConvexError("Team not found");
  return team;
}

async function resolveMemberByEmail(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  email: string
): Promise<Doc<"users">> {
  const normalized = email.trim().toLowerCase();
  const members = await ctx.db
    .query("members")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  for (const member of members) {
    const user = await ctx.db.get(member.userId);
    if (user?.email.toLowerCase() === normalized) return user;
  }
  throw new ConvexError("Workspace member not found");
}

async function resolveIssueByIdentifier(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  identifier: string
): Promise<Doc<"issues">> {
  const match = identifier.trim().match(/^([A-Za-z][A-Za-z0-9]{0,4})-(\d+)$/);
  if (!match) {
    throw new ConvexError("Issue identifier must look like ENG-42");
  }
  const team = await resolveTeamByKey(ctx, orgId, match[1]);
  const issue = await ctx.db
    .query("issues")
    .withIndex("by_team_and_number", (q) =>
      q.eq("teamId", team._id).eq("number", Number(match[2]))
    )
    .unique();
  if (!issue || issue.orgId !== orgId) throw new ConvexError("Issue not found");
  return issue;
}

async function resolveProject(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  projectId: string
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId as Id<"projects">);
  if (!project || project.orgId !== orgId) {
    throw new ConvexError("Project not found");
  }
  return project;
}

async function resolveCycle(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  cycleId: string
): Promise<Doc<"cycles">> {
  const cycle = await ctx.db.get(cycleId as Id<"cycles">);
  if (!cycle || cycle.orgId !== orgId) {
    throw new ConvexError("Cycle not found");
  }
  return cycle;
}

async function identifierFor(
  ctx: QueryCtx | MutationCtx,
  issue: Doc<"issues">
): Promise<string> {
  const team = await ctx.db.get(issue.teamId);
  return (team?.key ?? "?") + "-" + issue.number;
}

async function issueLabels(
  ctx: QueryCtx | MutationCtx,
  issueId: Id<"issues">
) {
  const links = await ctx.db
    .query("issueLabels")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const labels = [];
  for (const link of links) {
    const label = await ctx.db.get(link.labelId);
    if (label) {
      labels.push({ id: label._id, name: label.name, color: label.color });
    }
  }
  return labels;
}

async function issueView(
  ctx: QueryCtx | MutationCtx,
  issue: Doc<"issues">
) {
  const [team, assignee, project, cycle, labels] = await Promise.all([
    ctx.db.get(issue.teamId),
    issue.assigneeId ? ctx.db.get(issue.assigneeId) : Promise.resolve(null),
    issue.projectId ? ctx.db.get(issue.projectId) : Promise.resolve(null),
    issue.cycleId ? ctx.db.get(issue.cycleId) : Promise.resolve(null),
    issueLabels(ctx, issue._id),
  ]);
  return {
    id: issue._id,
    identifier: (team?.key ?? "?") + "-" + issue.number,
    title: issue.title,
    description: issue.description ?? null,
    status: issue.status,
    priority: issue.priority,
    assignee: assignee
      ? { id: assignee._id, name: assignee.name, email: assignee.email }
      : null,
    project: project ? { id: project._id, name: project.name } : null,
    cycle: cycle
      ? {
          id: cycle._id,
          name: cycle.name ?? "Cycle " + cycle.number,
          number: cycle.number,
        }
      : null,
    parentIssueId: issue.parentIssueId ?? null,
    estimate: issue.estimate ?? null,
    dueDate: issue.dueDate ?? null,
    labels,
    createdAt: issue._creationTime,
  };
}

function progress(issues: Doc<"issues">[]) {
  const counts = {
    total: issues.length,
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
  };
  for (const issue of issues) counts[issue.status] += 1;
  return counts;
}

async function validateAuth(
  ctx: QueryCtx | MutationCtx,
  auth: AuthContext
): Promise<{
  org: Doc<"organizations">;
  user: Doc<"users">;
  membership: Doc<"members">;
}> {
  const [org, user, membership] = await Promise.all([
    ctx.db.get(auth.orgId),
    ctx.db.get(auth.userId),
    ctx.db
      .query("members")
      .withIndex("by_org_and_user", (q) =>
        q.eq("orgId", auth.orgId).eq("userId", auth.userId)
      )
      .unique(),
  ]);
  if (!org || !user || !membership || membership.role !== auth.role) {
    throw new ConvexError("MCP credential is no longer authorized");
  }
  return { org, user, membership };
}

export const authenticateToken = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      credentialId: v.id("mcpCredentials"),
      orgId: v.id("organizations"),
      userId: v.id("users"),
      role: v.union(v.literal("admin"), v.literal("member")),
      plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
      scopes: v.array(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (
      !credential ||
      credential.revokedAt !== undefined ||
      (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())
    ) {
      return null;
    }
    const org = await ctx.db.get(credential.orgId);
    const user = await ctx.db.get(credential.userId);
    const membership = await ctx.db
      .query("members")
      .withIndex("by_org_and_user", (q) =>
        q.eq("orgId", credential.orgId).eq("userId", credential.userId)
      )
      .unique();
    if (!org || !user || !membership) return null;
    return {
      credentialId: credential._id,
      orgId: org._id,
      userId: user._id,
      role: membership.role,
      plan: org.plan,
      scopes: credential.scopes ?? ["mcp:read", "mcp:write"],
    };
  },
});

export const exchangeOAuthCode = internalMutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    accessTokenHash: v.string(),
    accessTokenPrefix: v.string(),
    refreshTokenHash: v.string(),
  },
  returns: v.object({
    scopes: v.array(v.string()),
    expiresIn: v.number(),
  }),
  handler: async (ctx, args) => {
    const code = await ctx.db
      .query("mcpOAuthCodes")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", args.codeHash))
      .unique();
    if (
      !code ||
      code.usedAt !== undefined ||
      code.expiresAt <= Date.now() ||
      code.clientId !== args.clientId ||
      code.redirectUri !== args.redirectUri ||
      code.codeChallenge !== args.codeChallenge
    ) {
      throw new ConvexError("Invalid or expired authorization code");
    }

    const membership = await ctx.db
      .query("members")
      .withIndex("by_org_and_user", (q) =>
        q.eq("orgId", code.orgId).eq("userId", code.userId)
      )
      .unique();
    if (!membership) {
      throw new ConvexError("Workspace membership no longer exists");
    }

    await ctx.db.patch(code._id, { usedAt: Date.now() });
    const expiresIn = 60 * 60;
    await ctx.db.insert("mcpCredentials", {
      orgId: code.orgId,
      userId: code.userId,
      name: "ChatGPT OAuth",
      tokenHash: args.accessTokenHash,
      tokenPrefix: args.accessTokenPrefix,
      expiresAt: Date.now() + expiresIn * 1000,
      scopes: code.scopes,
      oauthClientId: code.clientId,
      refreshTokenHash: args.refreshTokenHash,
    });
    return { scopes: code.scopes, expiresIn };
  },
});

export const refreshOAuthCredential = internalMutation({
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
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_refresh_token_hash", (q) =>
        q.eq("refreshTokenHash", args.currentRefreshTokenHash)
      )
      .unique();
    if (
      !credential ||
      credential.revokedAt !== undefined ||
      credential.oauthClientId !== args.clientId
    ) {
      throw new ConvexError("Invalid or revoked refresh token");
    }

    const membership = await ctx.db
      .query("members")
      .withIndex("by_org_and_user", (q) =>
        q.eq("orgId", credential.orgId).eq("userId", credential.userId)
      )
      .unique();
    if (!membership) {
      throw new ConvexError("Workspace membership no longer exists");
    }

    const expiresIn = 60 * 60;
    await ctx.db.patch(credential._id, {
      tokenHash: args.accessTokenHash,
      tokenPrefix: args.accessTokenPrefix,
      refreshTokenHash: args.refreshTokenHash,
      expiresAt: Date.now() + expiresIn * 1000,
      lastUsedAt: Date.now(),
    });
    return {
      scopes: credential.scopes ?? ["mcp:read", "mcp:write"],
      expiresIn,
    };
  },
});

export const touchCredential = internalMutation({
  args: { credentialId: v.id("mcpCredentials") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.credentialId);
    if (credential && credential.revokedAt === undefined) {
      await ctx.db.patch(args.credentialId, { lastUsedAt: Date.now() });
    }
    return null;
  },
});

export const executeRead = internalQuery({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("member")),
    operation: v.string(),
    input: v.any(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await validateAuth(ctx, args);
    const input = inputObject(args.input);

    switch (args.operation) {
      case "get_profile": {
        const org = await ctx.db.get(args.orgId);
        const user = await ctx.db.get(args.userId);
        return {
          workspace: {
            id: args.orgId,
            name: org?.name ?? "Workspace",
            plan: org?.plan ?? "free",
          },
          user: user
            ? { id: user._id, name: user.name, email: user.email }
            : null,
        };
      }

      case "list_teams": {
        const teams = await ctx.db
          .query("teams")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect();
        return teams.map((team) => ({
          id: team._id,
          name: team.name,
          key: team.key,
          description: team.description ?? null,
          issueCount: Math.max(0, team.nextIssueNumber - 1),
        }));
      }

      case "list_members": {
        const members = await ctx.db
          .query("members")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect();
        const result = [];
        for (const member of members) {
          const user = await ctx.db.get(member.userId);
          if (user) {
            result.push({
              id: user._id,
              name: user.name,
              email: user.email,
              role: member.role,
            });
          }
        }
        return result;
      }

      case "list_issues": {
        const teamKey = optionalString(input, "teamKey");
        const team = teamKey
          ? await resolveTeamByKey(ctx, args.orgId, teamKey)
          : null;
        const assigneeEmail = optionalString(input, "assigneeEmail");
        const assignee = assigneeEmail
          ? await resolveMemberByEmail(ctx, args.orgId, assigneeEmail)
          : null;
        const limit = boundedLimit(input);
        const status = optionalString(input, "status");
        const priority = optionalString(input, "priority");
        const projectId = optionalString(input, "projectId");
        const cycleId = optionalString(input, "cycleId");
        let issues = team
          ? await ctx.db
              .query("issues")
              .withIndex("by_team", (q) => q.eq("teamId", team._id))
              .order("desc")
              .take(400)
          : await ctx.db
              .query("issues")
              .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
              .order("desc")
              .take(400);
        issues = issues
          .filter((issue) => issue.orgId === args.orgId)
          .filter((issue) => !status || issue.status === status)
          .filter((issue) => !priority || issue.priority === priority)
          .filter((issue) => !assignee || issue.assigneeId === assignee._id)
          .filter((issue) => !projectId || issue.projectId === projectId)
          .filter((issue) => !cycleId || issue.cycleId === cycleId)
          .slice(0, limit);
        const result = [];
        for (const issue of issues) result.push(await issueView(ctx, issue));
        return result;
      }

      case "search_issues": {
        const query = requiredString(input, "query");
        const teamKey = optionalString(input, "teamKey");
        const team = teamKey
          ? await resolveTeamByKey(ctx, args.orgId, teamKey)
          : null;
        const limit = boundedLimit(input, 20);
        const byTitle = await ctx.db
          .query("issues")
          .withSearchIndex("search_title", (q) => {
            const base = q.search("title", query).eq("orgId", args.orgId);
            return team ? base.eq("teamId", team._id) : base;
          })
          .take(limit);
        const byDescription = await ctx.db
          .query("issues")
          .withSearchIndex("search_description", (q) => {
            const base = q.search("description", query).eq("orgId", args.orgId);
            return team ? base.eq("teamId", team._id) : base;
          })
          .take(limit);
        const unique = new Map<string, Doc<"issues">>();
        for (const issue of [...byTitle, ...byDescription]) {
          unique.set(issue._id, issue);
        }
        const result = [];
        for (const issue of [...unique.values()].slice(0, limit)) {
          result.push(await issueView(ctx, issue));
        }
        return result;
      }

      case "get_issue": {
        return await issueView(
          ctx,
          await resolveIssueByIdentifier(
            ctx,
            args.orgId,
            requiredString(input, "identifier")
          )
        );
      }

      case "list_comments": {
        const issue = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "identifier")
        );
        const comments = await ctx.db
          .query("comments")
          .withIndex("by_issue", (q) => q.eq("issueId", issue._id))
          .collect();
        const result = [];
        for (const comment of comments) {
          const author = comment.authorId
            ? await ctx.db.get(comment.authorId)
            : null;
          result.push({
            id: comment._id,
            createdAt: comment._creationTime,
            body: comment.body,
            author: comment.externalAuthor ?? author?.name ?? "Unknown user",
            authorId: comment.authorId ?? null,
            parentId: comment.parentId ?? null,
            mentions: comment.mentions ?? [],
          });
        }
        return result;
      }

      case "list_labels": {
        const labels = await ctx.db
          .query("labels")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect();
        return labels.map((label) => ({
          id: label._id,
          name: label.name,
          color: label.color,
        }));
      }

      case "list_projects": {
        const projects = await ctx.db
          .query("projects")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect();
        const result = [];
        for (const project of projects) {
          const issues = (
            await ctx.db
              .query("issues")
              .withIndex("by_project", (q) => q.eq("projectId", project._id))
              .collect()
          ).filter((issue) => issue.orgId === args.orgId);
          const lead = project.leadId ? await ctx.db.get(project.leadId) : null;
          result.push({
            id: project._id,
            name: project.name,
            description: project.description ?? null,
            status: project.status,
            lead: lead
              ? { id: lead._id, name: lead.name, email: lead.email }
              : null,
            targetDate: project.targetDate ?? null,
            color: project.color ?? null,
            progress: progress(issues),
          });
        }
        return result;
      }

      case "get_project":
      case "project_summary": {
        const project = await resolveProject(
          ctx,
          args.orgId,
          requiredString(input, "projectId")
        );
        const issues = (
          await ctx.db
            .query("issues")
            .withIndex("by_project", (q) => q.eq("projectId", project._id))
            .collect()
        ).filter((issue) => issue.orgId === args.orgId);
        const resultIssues = [];
        for (const issue of issues.slice(0, 100)) {
          resultIssues.push(await issueView(ctx, issue));
        }
        return {
          id: project._id,
          name: project.name,
          description: project.description ?? null,
          status: project.status,
          targetDate: project.targetDate ?? null,
          color: project.color ?? null,
          githubRepos: project.githubRepos ?? [],
          progress: progress(issues),
          issues: resultIssues,
        };
      }

      case "list_cycles": {
        const teamKey = optionalString(input, "teamKey");
        const teams = teamKey
          ? [await resolveTeamByKey(ctx, args.orgId, teamKey)]
          : await ctx.db
              .query("teams")
              .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
              .collect();
        const result = [];
        for (const team of teams) {
          const cycles = await ctx.db
            .query("cycles")
            .withIndex("by_team", (q) => q.eq("teamId", team._id))
            .collect();
          for (const cycle of cycles.sort((a, b) => b.number - a.number)) {
            const issues = (
              await ctx.db
                .query("issues")
                .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
                .collect()
            ).filter((issue) => issue.orgId === args.orgId);
            result.push({
              id: cycle._id,
              teamKey: team.key,
              number: cycle.number,
              name: cycle.name ?? "Cycle " + cycle.number,
              startDate: cycle.startDate,
              endDate: cycle.endDate,
              progress: progress(issues),
            });
          }
        }
        return result;
      }

      case "get_cycle":
      case "cycle_summary": {
        const cycle = await resolveCycle(
          ctx,
          args.orgId,
          requiredString(input, "cycleId")
        );
        const team = await ctx.db.get(cycle.teamId);
        const issues = (
          await ctx.db
            .query("issues")
            .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
            .collect()
        ).filter((issue) => issue.orgId === args.orgId);
        const resultIssues = [];
        for (const issue of issues.slice(0, 100)) {
          resultIssues.push(await issueView(ctx, issue));
        }
        return {
          id: cycle._id,
          teamKey: team?.key ?? "?",
          number: cycle.number,
          name: cycle.name ?? "Cycle " + cycle.number,
          startDate: cycle.startDate,
          endDate: cycle.endDate,
          progress: progress(issues),
          issues: resultIssues,
        };
      }

      case "list_issue_relations": {
        const issue = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "identifier")
        );
        const outgoing = await ctx.db
          .query("issueRelations")
          .withIndex("by_issue", (q) => q.eq("issueId", issue._id))
          .collect();
        const incoming = await ctx.db
          .query("issueRelations")
          .withIndex("by_related", (q) => q.eq("relatedIssueId", issue._id))
          .collect();
        const relations = [];
        const inverse: Record<string, string> = {
          blocks: "blocked_by",
          blocked_by: "blocks",
          related: "related",
          duplicate_of: "duplicated_by",
        };
        for (const relation of outgoing) {
          const other = await ctx.db.get(relation.relatedIssueId);
          if (other && other.orgId === args.orgId) {
            relations.push({
              relationId: relation._id,
              type: relation.type,
              identifier: await identifierFor(ctx, other),
              title: other.title,
            });
          }
        }
        for (const relation of incoming) {
          const other = await ctx.db.get(relation.issueId);
          if (other && other.orgId === args.orgId) {
            relations.push({
              relationId: relation._id,
              type: inverse[relation.type],
              identifier: await identifierFor(ctx, other),
              title: other.title,
            });
          }
        }
        const children = await ctx.db
          .query("issues")
          .withIndex("by_parent", (q) => q.eq("parentIssueId", issue._id))
          .collect();
        const subIssues = [];
        for (const child of children.filter((item) => item.orgId === args.orgId)) {
          subIssues.push(await issueView(ctx, child));
        }
        const parent =
          issue.parentIssueId !== undefined
            ? await ctx.db.get(issue.parentIssueId)
            : null;
        return {
          relations,
          parent:
            parent && parent.orgId === args.orgId
              ? await issueView(ctx, parent)
              : null,
          subIssues,
        };
      }

      case "workspace_summary": {
        const [org, teams, members, issues, projects] = await Promise.all([
          ctx.db.get(args.orgId),
          ctx.db
            .query("teams")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect(),
          ctx.db
            .query("members")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect(),
          ctx.db
            .query("issues")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect(),
          ctx.db
            .query("projects")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect(),
        ]);
        let cycleCount = 0;
        for (const team of teams) {
          cycleCount += (
            await ctx.db
              .query("cycles")
              .withIndex("by_team", (q) => q.eq("teamId", team._id))
              .collect()
          ).length;
        }
        const now = Date.now();
        return {
          name: org?.name ?? "Workspace",
          plan: org?.plan ?? "free",
          counts: {
            members: members.length,
            teams: teams.length,
            projects: projects.length,
            cycles: cycleCount,
            issues: issues.length,
            overdue: issues.filter(
              (issue) =>
                issue.dueDate !== undefined &&
                issue.dueDate < now &&
                issue.status !== "done" &&
                issue.status !== "canceled"
            ).length,
          },
          status: progress(issues),
          priorities: {
            urgent: issues.filter((issue) => issue.priority === "urgent").length,
            high: issues.filter((issue) => issue.priority === "high").length,
            medium: issues.filter((issue) => issue.priority === "medium").length,
            low: issues.filter((issue) => issue.priority === "low").length,
            none: issues.filter((issue) => issue.priority === "none").length,
          },
        };
      }

      default:
        throw new ConvexError("Unknown read operation: " + args.operation);
    }
  },
});

async function updateIssueFields(
  ctx: MutationCtx,
  auth: AuthContext,
  input: AnyInput
) {
  const issue = await resolveIssueByIdentifier(
    ctx,
    auth.orgId,
    requiredString(input, "identifier")
  );
  const updates: Partial<Doc<"issues">> = {};
  const changes: Array<{
    field: string;
    oldValue?: string;
    newValue?: string;
  }> = [];

  const title = optionalString(input, "title");
  if (title !== undefined) {
    if (!title.trim()) throw new ConvexError("title cannot be empty");
    if (title.trim() !== issue.title) {
      updates.title = title.trim();
      changes.push({ field: "title", oldValue: issue.title, newValue: title.trim() });
    }
  }

  const description = optionalNullableString(input, "description");
  if (description !== undefined && description !== issue.description) {
    updates.description = description ?? undefined;
    changes.push({ field: "description" });
  }

  const status = optionalString(input, "status");
  if (status !== undefined) {
    if (!ISSUE_STATUSES.has(status)) throw new ConvexError("Invalid status");
    if (status !== issue.status) {
      updates.status = status as Doc<"issues">["status"];
      changes.push({ field: "status", oldValue: issue.status, newValue: status });
    }
  }

  const priority = optionalString(input, "priority");
  if (priority !== undefined) {
    if (!ISSUE_PRIORITIES.has(priority)) throw new ConvexError("Invalid priority");
    if (priority !== issue.priority) {
      updates.priority = priority as Doc<"issues">["priority"];
      changes.push({
        field: "priority",
        oldValue: issue.priority,
        newValue: priority,
      });
    }
  }

  const assigneeEmail = optionalNullableString(input, "assigneeEmail");
  let newAssignee = issue.assigneeId;
  if (assigneeEmail !== undefined) {
    newAssignee =
      assigneeEmail === null
        ? undefined
        : (await resolveMemberByEmail(ctx, auth.orgId, assigneeEmail))._id;
    if (newAssignee !== issue.assigneeId) {
      updates.assigneeId = newAssignee;
      changes.push({
        field: "assignee",
        oldValue: issue.assigneeId,
        newValue: newAssignee,
      });
    }
  }

  const projectId = optionalNullableString(input, "projectId");
  if (projectId !== undefined) {
    if (projectId !== null) await resolveProject(ctx, auth.orgId, projectId);
    updates.projectId = projectId ? (projectId as Id<"projects">) : undefined;
    if ((issue.projectId ?? null) !== projectId) {
      changes.push({
        field: "project",
        oldValue: issue.projectId,
        newValue: projectId ?? undefined,
      });
    }
  }

  const cycleId = optionalNullableString(input, "cycleId");
  if (cycleId !== undefined) {
    if (cycleId !== null) {
      const cycle = await resolveCycle(ctx, auth.orgId, cycleId);
      if (cycle.teamId !== issue.teamId) {
        throw new ConvexError("Cycle belongs to a different team");
      }
    }
    updates.cycleId = cycleId ? (cycleId as Id<"cycles">) : undefined;
    if ((issue.cycleId ?? null) !== cycleId) {
      changes.push({
        field: "cycle",
        oldValue: issue.cycleId,
        newValue: cycleId ?? undefined,
      });
    }
  }

  const estimate = optionalNullableNumber(input, "estimate");
  if (estimate !== undefined) {
    if (estimate !== null && estimate < 0) {
      throw new ConvexError("estimate cannot be negative");
    }
    updates.estimate = estimate ?? undefined;
    if ((issue.estimate ?? null) !== estimate) {
      changes.push({
        field: "estimate",
        oldValue: issue.estimate?.toString(),
        newValue: estimate?.toString(),
      });
    }
  }

  const dueDate = optionalNullableNumber(input, "dueDate");
  if (dueDate !== undefined) {
    updates.dueDate = dueDate ?? undefined;
    if ((issue.dueDate ?? null) !== dueDate) {
      changes.push({
        field: "due_date",
        oldValue: issue.dueDate?.toString(),
        newValue: dueDate?.toString(),
      });
    }
  }

  if (changes.length === 0) return await issueView(ctx, issue);

  await ctx.db.patch(issue._id, updates);

  for (const change of changes) {
    await logActivity(ctx, {
      orgId: auth.orgId,
      issueId: issue._id,
      actorId: auth.userId,
      type: change.field + "_changed",
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
    });
  }

  if (newAssignee && newAssignee !== issue.assigneeId) {
    await createNotification(ctx, {
      orgId: auth.orgId,
      userId: newAssignee,
      actorId: auth.userId,
      issueId: issue._id,
      type: "assigned",
    });
  }

  if (updates.status) {
    const recipients = new Set(
      [issue.creatorId, newAssignee].filter(
        (id): id is Id<"users"> => id !== undefined
      )
    );
    for (const userId of recipients) {
      await createNotification(ctx, {
        orgId: auth.orgId,
        userId,
        actorId: auth.userId,
        issueId: issue._id,
        type: "status_changed",
        newValue: updates.status,
      });
    }
  }

  if (
    updates.title !== undefined ||
    description !== undefined ||
    updates.status !== undefined
  ) {
    await scheduleGithubIssueSync(ctx, issue._id);
  }
  if (description !== undefined && description !== null) {
    await autoLinkFigmaUrls(ctx, {
      orgId: auth.orgId,
      issueId: issue._id,
      actorId: auth.userId,
      text: description,
    });
  }
  if (updates.title !== undefined || updates.status !== undefined) {
    await scheduleFigmaDevSync(ctx, issue._id);
  }
  if (updates.title !== undefined || description !== undefined) {
    await ctx.scheduler.runAfter(0, internal.agent.embeddings.embedIssue, {
      issueId: issue._id,
    });
  }

  return await issueView(ctx, (await ctx.db.get(issue._id))!);
}

export const executeWrite = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("member")),
    operation: v.string(),
    input: v.any(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { org, user, membership } = await validateAuth(ctx, args);
    const input = inputObject(args.input);

    switch (args.operation) {
      case "create_team": {
        if (membership.role !== "admin") {
          throw new ConvexError("Only workspace admins can create teams");
        }
        const name = requiredString(input, "name");
        const key = requiredString(input, "key").toUpperCase();
        if (!/^[A-Z][A-Z0-9]{0,4}$/.test(key)) {
          throw new ConvexError(
            "Team key must be 1-5 characters, starting with a letter"
          );
        }
        const existing = await ctx.db
          .query("teams")
          .withIndex("by_org_and_key", (q) =>
            q.eq("orgId", args.orgId).eq("key", key)
          )
          .unique();
        if (existing) throw new ConvexError("Team key is already in use");
        const teamId = await ctx.db.insert("teams", {
          orgId: args.orgId,
          name,
          key,
          description: optionalString(input, "description"),
          nextIssueNumber: 1,
        });
        return { teamId, key };
      }

      case "create_issue": {
        const team = await resolveTeamByKey(
          ctx,
          args.orgId,
          requiredString(input, "teamKey")
        );
        const assigneeEmail = optionalString(input, "assigneeEmail");
        const assignee = assigneeEmail
          ? await resolveMemberByEmail(ctx, args.orgId, assigneeEmail)
          : undefined;
        const projectId = optionalString(input, "projectId");
        if (projectId) await resolveProject(ctx, args.orgId, projectId);
        const cycleId = optionalString(input, "cycleId");
        if (cycleId) {
          const cycle = await resolveCycle(ctx, args.orgId, cycleId);
          if (cycle.teamId !== team._id) {
            throw new ConvexError("Cycle belongs to a different team");
          }
        }
        const parentIdentifier = optionalString(input, "parentIdentifier");
        const parent = parentIdentifier
          ? await resolveIssueByIdentifier(ctx, args.orgId, parentIdentifier)
          : undefined;
        const status = optionalString(input, "status");
        if (status && !ISSUE_STATUSES.has(status)) {
          throw new ConvexError("Invalid status");
        }
        const priority = optionalString(input, "priority");
        if (priority && !ISSUE_PRIORITIES.has(priority)) {
          throw new ConvexError("Invalid priority");
        }
        const labelIds = stringArray(input, "labelIds");
        if (labelIds) {
          for (const labelId of labelIds) {
            const label = await ctx.db.get(labelId as Id<"labels">);
            if (!label || label.orgId !== args.orgId) {
              throw new ConvexError("Label not found");
            }
          }
        }
        const issueId = await insertIssue(ctx, {
          org,
          team,
          creatorId: user._id,
          title: requiredString(input, "title"),
          description: optionalString(input, "description"),
          status: status as Doc<"issues">["status"] | undefined,
          priority: priority as Doc<"issues">["priority"] | undefined,
          assigneeId: assignee?._id,
          projectId: projectId as Id<"projects"> | undefined,
          cycleId: cycleId as Id<"cycles"> | undefined,
          parentIssueId: parent?._id,
          estimate: optionalNumber(input, "estimate"),
          dueDate: optionalNumber(input, "dueDate"),
          labelIds: labelIds?.map((id) => id as Id<"labels">),
        });
        await ctx.scheduler.runAfter(0, internal.agent.embeddings.embedIssue, {
          issueId,
        });
        const description = optionalString(input, "description");
        if (description) {
          await autoLinkFigmaUrls(ctx, {
            orgId: args.orgId,
            issueId,
            actorId: user._id,
            text: description,
          });
        }
        return await issueView(ctx, (await ctx.db.get(issueId))!);
      }

      case "update_issue":
        return await updateIssueFields(ctx, args, input);

      case "assign_issue":
        return await updateIssueFields(ctx, args, {
          identifier: requiredString(input, "identifier"),
          assigneeEmail: optionalNullableString(input, "assigneeEmail") ?? null,
        });

      case "set_issue_status":
        return await updateIssueFields(ctx, args, {
          identifier: requiredString(input, "identifier"),
          status: requiredString(input, "status"),
        });

      case "set_issue_priority":
        return await updateIssueFields(ctx, args, {
          identifier: requiredString(input, "identifier"),
          priority: requiredString(input, "priority"),
        });

      case "set_issue_estimate":
        return await updateIssueFields(ctx, args, {
          identifier: requiredString(input, "identifier"),
          estimate: input.estimate === null ? null : requiredNumber(input, "estimate"),
        });

      case "set_issue_due_date":
        return await updateIssueFields(ctx, args, {
          identifier: requiredString(input, "identifier"),
          dueDate: input.dueDate === null ? null : requiredNumber(input, "dueDate"),
        });

      case "delete_issue": {
        const issue = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "identifier")
        );
        const links = await ctx.db
          .query("issueLabels")
          .withIndex("by_issue", (q) => q.eq("issueId", issue._id))
          .collect();
        for (const link of links) await ctx.db.delete(link._id);
        await ctx.db.delete(issue._id);
        return { deleted: true, identifier: await identifierFor(ctx, issue) };
      }

      case "create_comment": {
        const issue = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "identifier")
        );
        const body = requiredString(input, "body");
        const mentionEmails = stringArray(input, "mentionEmails") ?? [];
        const mentions: Id<"users">[] = [];
        for (const email of mentionEmails) {
          mentions.push((await resolveMemberByEmail(ctx, args.orgId, email))._id);
        }
        let parentId: Id<"comments"> | undefined;
        let replyRecipient: Id<"users"> | undefined;
        const requestedParentId = optionalString(input, "parentCommentId");
        if (requestedParentId) {
          const parent = await ctx.db.get(requestedParentId as Id<"comments">);
          if (!parent || parent.orgId !== args.orgId || parent.issueId !== issue._id) {
            throw new ConvexError("Parent comment not found");
          }
          if (parent.parentId) {
            parentId = parent.parentId;
            const root = await ctx.db.get(parent.parentId);
            replyRecipient = root?.authorId;
          } else {
            parentId = parent._id;
            replyRecipient = parent.authorId;
          }
        }
        const commentId = await ctx.db.insert("comments", {
          orgId: args.orgId,
          issueId: issue._id,
          authorId: user._id,
          body,
          mentions,
          ...(parentId ? { parentId } : {}),
        });
        await logActivity(ctx, {
          orgId: args.orgId,
          issueId: issue._id,
          actorId: user._id,
          type: "commented",
        });
        for (const userId of mentions) {
          await createNotification(ctx, {
            orgId: args.orgId,
            userId,
            actorId: user._id,
            issueId: issue._id,
            type: "mention",
            commentId,
          });
        }
        if (replyRecipient) {
          await createNotification(ctx, {
            orgId: args.orgId,
            userId: replyRecipient,
            actorId: user._id,
            issueId: issue._id,
            type: "reply",
            commentId,
          });
        }
        await autoLinkFigmaUrls(ctx, {
          orgId: args.orgId,
          issueId: issue._id,
          actorId: user._id,
          text: body,
        });
        return { commentId };
      }

      case "update_comment": {
        const commentId = requiredString(input, "commentId") as Id<"comments">;
        const comment = await ctx.db.get(commentId);
        if (!comment || comment.orgId !== args.orgId) {
          throw new ConvexError("Comment not found");
        }
        if (comment.authorId !== user._id) {
          throw new ConvexError("Only the author can edit a comment");
        }
        const body = requiredString(input, "body");
        await ctx.db.patch(commentId, { body });
        return { updated: true, commentId };
      }

      case "delete_comment": {
        const commentId = requiredString(input, "commentId") as Id<"comments">;
        const comment = await ctx.db.get(commentId);
        if (!comment || comment.orgId !== args.orgId) {
          throw new ConvexError("Comment not found");
        }
        if (comment.authorId !== user._id && membership.role !== "admin") {
          throw new ConvexError("Only the author or an admin can delete a comment");
        }
        if (!comment.parentId) {
          const replies = await ctx.db
            .query("comments")
            .withIndex("by_parent", (q) => q.eq("parentId", commentId))
            .collect();
          for (const reply of replies) await ctx.db.delete(reply._id);
        }
        await ctx.db.delete(commentId);
        return { deleted: true, commentId };
      }

      case "create_label": {
        const labelId = await ctx.db.insert("labels", {
          orgId: args.orgId,
          name: requiredString(input, "name"),
          color: requiredString(input, "color"),
        });
        return { labelId };
      }

      case "add_issue_label":
      case "remove_issue_label": {
        const issue = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "identifier")
        );
        const labelId = requiredString(input, "labelId") as Id<"labels">;
        const label = await ctx.db.get(labelId);
        if (!label || label.orgId !== args.orgId) {
          throw new ConvexError("Label not found");
        }
        const links = await ctx.db
          .query("issueLabels")
          .withIndex("by_issue", (q) => q.eq("issueId", issue._id))
          .collect();
        const existing = links.find((link) => link.labelId === labelId);
        if (args.operation === "add_issue_label" && !existing) {
          await ctx.db.insert("issueLabels", { issueId: issue._id, labelId });
          await logActivity(ctx, {
            orgId: args.orgId,
            issueId: issue._id,
            actorId: user._id,
            type: "labeled",
            newValue: label.name,
          });
        }
        if (args.operation === "remove_issue_label" && existing) {
          await ctx.db.delete(existing._id);
          await logActivity(ctx, {
            orgId: args.orgId,
            issueId: issue._id,
            actorId: user._id,
            type: "unlabeled",
            oldValue: label.name,
          });
        }
        return { labels: await issueLabels(ctx, issue._id) };
      }

      case "create_project": {
        await assertCanCreateProject(ctx, org);
        const name = requiredString(input, "name");
        const status = optionalString(input, "status") ?? "planned";
        if (!PROJECT_STATUSES.has(status)) throw new ConvexError("Invalid status");
        const leadEmail = optionalString(input, "leadEmail");
        const lead = leadEmail
          ? await resolveMemberByEmail(ctx, args.orgId, leadEmail)
          : undefined;
        const projectId = await ctx.db.insert("projects", {
          orgId: args.orgId,
          name,
          description: optionalString(input, "description"),
          status: status as Doc<"projects">["status"],
          leadId: lead?._id,
          targetDate: optionalNumber(input, "targetDate"),
          color: optionalString(input, "color"),
        });
        return { projectId };
      }

      case "update_project": {
        const project = await resolveProject(
          ctx,
          args.orgId,
          requiredString(input, "projectId")
        );
        const updates: Partial<Doc<"projects">> = {};
        const name = optionalString(input, "name");
        if (name !== undefined) {
          if (!name.trim()) throw new ConvexError("Project name cannot be empty");
          updates.name = name.trim();
        }
        const description = optionalNullableString(input, "description");
        if (description !== undefined) updates.description = description ?? undefined;
        const status = optionalString(input, "status");
        if (status !== undefined) {
          if (!PROJECT_STATUSES.has(status)) throw new ConvexError("Invalid status");
          updates.status = status as Doc<"projects">["status"];
        }
        const leadEmail = optionalNullableString(input, "leadEmail");
        if (leadEmail !== undefined) {
          updates.leadId =
            leadEmail === null
              ? undefined
              : (await resolveMemberByEmail(ctx, args.orgId, leadEmail))._id;
        }
        const targetDate = optionalNullableNumber(input, "targetDate");
        if (targetDate !== undefined) updates.targetDate = targetDate ?? undefined;
        const color = optionalNullableString(input, "color");
        if (color !== undefined) updates.color = color ?? undefined;
        await ctx.db.patch(project._id, updates);
        return { updated: true, projectId: project._id };
      }

      case "delete_project": {
        const project = await resolveProject(
          ctx,
          args.orgId,
          requiredString(input, "projectId")
        );
        const issues = await ctx.db
          .query("issues")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .collect();
        for (const issue of issues) {
          if (issue.orgId !== args.orgId) continue;
          await ctx.db.patch(issue._id, { projectId: undefined });
          await logActivity(ctx, {
            orgId: args.orgId,
            issueId: issue._id,
            actorId: user._id,
            type: "project_changed",
            field: "project",
            oldValue: project.name,
          });
        }
        await ctx.db.delete(project._id);
        return { deleted: true, projectId: project._id };
      }

      case "create_cycle": {
        const team = await resolveTeamByKey(
          ctx,
          args.orgId,
          requiredString(input, "teamKey")
        );
        const startDate = requiredNumber(input, "startDate");
        const endDate = requiredNumber(input, "endDate");
        if (endDate <= startDate) {
          throw new ConvexError("Cycle end date must be after start date");
        }
        const latest = await ctx.db
          .query("cycles")
          .withIndex("by_team_and_number", (q) => q.eq("teamId", team._id))
          .order("desc")
          .first();
        const cycleId = await ctx.db.insert("cycles", {
          orgId: args.orgId,
          teamId: team._id,
          number: (latest?.number ?? 0) + 1,
          name: optionalString(input, "name")?.trim() || undefined,
          startDate,
          endDate,
        });
        return { cycleId };
      }

      case "update_cycle": {
        const cycle = await resolveCycle(
          ctx,
          args.orgId,
          requiredString(input, "cycleId")
        );
        const startDate = optionalNumber(input, "startDate") ?? cycle.startDate;
        const endDate = optionalNumber(input, "endDate") ?? cycle.endDate;
        if (endDate <= startDate) {
          throw new ConvexError("Cycle end date must be after start date");
        }
        const updates: Partial<Doc<"cycles">> = {};
        const name = optionalNullableString(input, "name");
        if (name !== undefined) updates.name = name?.trim() || undefined;
        if (input.startDate !== undefined) updates.startDate = startDate;
        if (input.endDate !== undefined) updates.endDate = endDate;
        await ctx.db.patch(cycle._id, updates);
        return { updated: true, cycleId: cycle._id };
      }

      case "delete_cycle": {
        const cycle = await resolveCycle(
          ctx,
          args.orgId,
          requiredString(input, "cycleId")
        );
        const issues = await ctx.db
          .query("issues")
          .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
          .collect();
        for (const issue of issues) {
          if (issue.orgId !== args.orgId) continue;
          await ctx.db.patch(issue._id, { cycleId: undefined });
          await logActivity(ctx, {
            orgId: args.orgId,
            issueId: issue._id,
            actorId: user._id,
            type: "cycle_changed",
            field: "cycle",
            oldValue: cycle.name ?? "Cycle " + cycle.number,
          });
        }
        await ctx.db.delete(cycle._id);
        return { deleted: true, cycleId: cycle._id };
      }

      case "create_issue_relation": {
        const issue = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "identifier")
        );
        const related = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "relatedIdentifier")
        );
        if (issue._id === related._id) {
          throw new ConvexError("An issue cannot be related to itself");
        }
        let type = requiredString(input, "type");
        if (!RELATION_TYPES.has(type)) throw new ConvexError("Invalid relation type");
        let from = issue;
        let to = related;
        if (type === "blocked_by") {
          from = related;
          to = issue;
          type = "blocks";
        }
        const outgoing = await ctx.db
          .query("issueRelations")
          .withIndex("by_issue", (q) => q.eq("issueId", issue._id))
          .collect();
        const incoming = await ctx.db
          .query("issueRelations")
          .withIndex("by_related", (q) => q.eq("relatedIssueId", issue._id))
          .collect();
        if (
          outgoing.some((relation) => relation.relatedIssueId === related._id) ||
          incoming.some((relation) => relation.issueId === related._id)
        ) {
          throw new ConvexError("These issues are already linked");
        }
        const relationId = await ctx.db.insert("issueRelations", {
          issueId: from._id,
          relatedIssueId: to._id,
          type: type as Doc<"issueRelations">["type"],
        });
        await logActivity(ctx, {
          orgId: args.orgId,
          issueId: issue._id,
          actorId: user._id,
          type: "relation_added",
          field: requiredString(input, "type"),
          newValue: await identifierFor(ctx, related),
        });
        return { relationId };
      }

      case "delete_issue_relation": {
        const relationId = requiredString(
          input,
          "relationId"
        ) as Id<"issueRelations">;
        const relation = await ctx.db.get(relationId);
        if (!relation) throw new ConvexError("Relation not found");
        await getOrgIssue(ctx, args.orgId, relation.issueId);
        await getOrgIssue(ctx, args.orgId, relation.relatedIssueId);
        await ctx.db.delete(relationId);
        return { deleted: true, relationId };
      }

      case "set_issue_parent": {
        const issue = await resolveIssueByIdentifier(
          ctx,
          args.orgId,
          requiredString(input, "identifier")
        );
        const parentIdentifier = optionalNullableString(input, "parentIdentifier");
        let parentId: Id<"issues"> | undefined;
        if (parentIdentifier) {
          const parent = await resolveIssueByIdentifier(
            ctx,
            args.orgId,
            parentIdentifier
          );
          if (parent._id === issue._id) {
            throw new ConvexError("An issue cannot be its own parent");
          }
          let ancestor: Doc<"issues"> | null = parent;
          for (let depth = 0; ancestor && depth < 100; depth++) {
            if (ancestor._id === issue._id) {
              throw new ConvexError("Cannot create a sub-issue cycle");
            }
            ancestor = ancestor.parentIssueId
              ? await ctx.db.get(ancestor.parentIssueId)
              : null;
            if (ancestor && ancestor.orgId !== args.orgId) ancestor = null;
          }
          parentId = parent._id;
        }
        await ctx.db.patch(issue._id, { parentIssueId: parentId });
        await logActivity(ctx, {
          orgId: args.orgId,
          issueId: issue._id,
          actorId: user._id,
          type: "parent_changed",
          field: "parent",
          oldValue: issue.parentIssueId,
          newValue: parentId,
        });
        return await issueView(ctx, (await ctx.db.get(issue._id))!);
      }

      default:
        throw new ConvexError("Unknown write operation: " + args.operation);
    }
  },
});
