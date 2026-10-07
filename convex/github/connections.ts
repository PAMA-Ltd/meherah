import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

// Bound account reads without silently omitting an installation.
export const MAX_GITHUB_CONNECTIONS = 100;

export async function listGithubConnections(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">
): Promise<(Doc<"integrations"> & { installationId: number })[]> {
  const rows = await ctx.db.query("integrations")
    .withIndex("by_org_and_type", q => q.eq("orgId", orgId).eq("type", "github"))
    .take(MAX_GITHUB_CONNECTIONS + 1);
  if (rows.length > MAX_GITHUB_CONNECTIONS) {
    throw new Error("Too many GitHub account connections");
  }
  return rows.filter((row): row is Doc<"integrations"> & { installationId: number } =>
    row.installationId !== undefined
  );
}

export type GithubInstallation = { installationId: number; repositories: string[] };

type RepositoryPreferences = { repositories?: string[]; disabledRepositories?: string[] };

// Older connections have no preferences: opt every repository out by default.
export function disabledRepositories(connection: RepositoryPreferences) {
  return (connection.disabledRepositories ?? connection.repositories ?? []).map(repo => repo.toLowerCase());
}

// Newly granted repositories must be opted in, even after a metadata refresh.
export function refreshedDisabledRepositories(connection: RepositoryPreferences, repositories: string[]) {
  const disabled = new Set(disabledRepositories(connection));
  const known = new Set((connection.repositories ?? []).map(repo => repo.toLowerCase()));
  for (const repo of repositories) {
    if (!known.has(repo.toLowerCase())) disabled.add(repo.toLowerCase());
  }
  if (disabled.size > 8192) throw new Error("Too many disabled repositories");
  return [...disabled].sort();
}

export function isRepositoryEnabled(
  connection: RepositoryPreferences,
  repo: string,
) {
  return (connection.repositories ?? []).some(name => name.toLowerCase() === repo.toLowerCase())
    && !disabledRepositories(connection).includes(repo.toLowerCase());
}

export function enabledRepositories(connection: RepositoryPreferences) {
  const disabled = new Set(disabledRepositories(connection));
  return (connection.repositories ?? []).filter(repo => !disabled.has(repo.toLowerCase()));
}

export function repositoryInstallation(installations: GithubInstallation[], repo: string) {
  return installations.find(installation =>
    installation.repositories.some(repository => repository.toLowerCase() === repo.toLowerCase())
  );
}
