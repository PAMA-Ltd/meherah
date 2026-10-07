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

export function repositoryInstallation(installations: GithubInstallation[], repo: string) {
  return installations.find(installation =>
    installation.repositories.some(repository => repository.toLowerCase() === repo.toLowerCase())
  );
}
