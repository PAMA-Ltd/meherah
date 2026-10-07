import { createHash, randomBytes } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { validateOAuthAuthorization } from "@/lib/mcp-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session.userId || !session.orgId) {
      return Response.json(
        { error: "An active Meherah workspace is required" },
        { status: 401 }
      );
    }

    const params = new URLSearchParams(await request.text());
    const origin = new URL(request.url).origin;
    const fields = await validateOAuthAuthorization(origin, params);
    const jwt = await session.getToken({ template: "convex" });
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!jwt || !convexUrl) throw new Error("Meherah auth is not configured");

    const code = "mhr_code_" + randomBytes(32).toString("base64url");
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(jwt);
    await client.mutation(api.mcp.issueOAuthCode, {
      codeHash: hash(code),
      clientId: fields.clientId,
      redirectUri: fields.redirectUri,
      codeChallenge: fields.codeChallenge,
      resource: fields.resource,
      scopes: fields.scopes,
    });

    const redirect = new URL(fields.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", fields.state);
    return Response.redirect(redirect, 302);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authorization failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
