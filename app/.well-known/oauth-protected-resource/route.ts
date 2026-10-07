import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

export function GET() {
  const origin = new URL(SITE_URL).origin;
  return Response.json(
    {
      resource: origin + "/api/mcp",
      authorization_servers: [origin],
      scopes_supported: ["mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
