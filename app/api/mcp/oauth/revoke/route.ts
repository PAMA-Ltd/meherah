import { createHash } from "crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function POST(request: Request) {
  const form = new URLSearchParams(await request.text());
  const token = form.get("token");
  if (!token) {
    return Response.json(
      { error: "invalid_request", error_description: "token is required" },
      { status: 400 }
    );
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  const client = new ConvexHttpClient(convexUrl);
  await client.mutation(api.mcp.revokeOAuthToken, {
    tokenHash: hash(token),
  });

  // RFC 7009 returns success even when the token was already invalid.
  return new Response(null, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}
