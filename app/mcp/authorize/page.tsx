import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  hiddenOAuthFields,
  validateOAuthAuthorization,
} from "@/lib/mcp-oauth";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

type SearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session.userId) {
    redirect("/sign-in");
  }
  if (!session.orgId) {
    redirect("/onboarding");
  }

  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(raw)) {
    const item = first(rawValue);
    if (item !== undefined) params.set(key, item);
  }

  let fields;
  try {
    fields = await validateOAuthAuthorization(
      new URL(SITE_URL).origin,
      params
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid authorization request";
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
        <section className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Meherah MCP
          </p>
          <h1 className="mt-2 text-xl font-semibold">Connection request invalid</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>
        </section>
      </main>
    );
  }

  const hidden = hiddenOAuthFields(fields);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Meherah MCP
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Connect ChatGPT?
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          ChatGPT will be able to read and update your active Meherah
          workspace. You can revoke this connection from Meherah at any time.
        </p>

        <div className="mt-5 rounded-xl border bg-muted/30 p-4">
          <p className="text-xs font-medium text-muted-foreground">
            Requested permissions
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {fields.scopes.map((scope) => (
              <span
                key={scope}
                className="rounded-md border bg-background px-2 py-1 text-xs font-medium"
              >
                {scope === "mcp:read" ? "Read workspace data" : "Update workspace data"}
              </span>
            ))}
          </div>
        </div>

        <form
          method="post"
          action="/api/mcp/oauth/authorize/confirm"
          className="mt-6"
        >
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <button
            type="submit"
            className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Authorize ChatGPT
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Only the workspace active in this browser session will be connected.
        </p>
      </section>
    </main>
  );
}
