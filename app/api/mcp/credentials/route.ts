import { createHash, randomBytes } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authenticatedConvex() {
  const session = await auth();
  if (!session.userId || !session.orgId) {
    throw new Error("An active Meherah workspace is required");
  }
  const token = await session.getToken({ template: "convex" });
  if (!token) throw new Error("Could not mint a Convex session token");
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

export async function GET() {
  try {
    const client = await authenticatedConvex();
    const credentials = await client.query(api.mcp.listCredentials, {});
    return Response.json(
      { credentials },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return Response.json({ error: message }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const client = await authenticatedConvex();
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      expiresAt?: unknown;
    };
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : "ChatGPT";
    const expiresAt =
      typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
        ? body.expiresAt
        : undefined;

    const secret = "mhr_mcp_" + randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(secret).digest("hex");
    const tokenPrefix = secret.slice(0, 16);
    const credentialId = await client.mutation(api.mcp.createCredential, {
      name,
      tokenHash,
      tokenPrefix,
      expiresAt,
    });

    return Response.json(
      {
        credentialId,
        token: secret,
        tokenPrefix,
        message:
          "Copy this token now. Meherah stores only its hash and cannot show it again.",
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create credential";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const client = await authenticatedConvex();
    const body = (await request.json()) as { credentialId?: unknown };
    if (typeof body.credentialId !== "string") {
      return Response.json(
        { error: "credentialId is required" },
        { status: 400 }
      );
    }
    await client.mutation(api.mcp.revokeCredential, {
      credentialId: body.credentialId as Id<"mcpCredentials">,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not revoke credential";
    return Response.json({ error: message }, { status: 400 });
  }
}
