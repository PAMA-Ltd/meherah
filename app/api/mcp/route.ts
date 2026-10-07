import { createHash } from "crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;
type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const SERVER_INFO = { name: "Meherah", version: "1.0.0" };

function objectSchema(
  properties: Record<string, unknown> = {},
  required: string[] = []
) {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = []
) {
  return { name, description, inputSchema: objectSchema(properties, required) };
}

const issueIdentifier = {
  type: "string",
  description: "Meherah issue identifier such as ENG-42",
};
const issueStatus = {
  type: "string",
  enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"],
};
const issuePriority = {
  type: "string",
  enum: ["none", "urgent", "high", "medium", "low"],
};
const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };

const TOOLS = [
  tool("workspace_summary", "Summarize this workspace: plan, member/team/project/cycle totals, issue status counts, priorities, and overdue work."),
  tool("list_teams", "List teams in this workspace with their keys and issue counts."),
  tool(
    "create_team",
    "Create a team. Workspace admin credentials only.",
    {
      name: { type: "string" },
      key: { type: "string", description: "1-5 character issue prefix such as ENG" },
      description: { type: "string" },
    },
    ["name", "key"]
  ),
  tool("list_members", "List workspace members with names, emails, and roles."),
  tool(
    "list_issues",
    "List issues with optional workspace-safe filters.",
    {
      teamKey: { type: "string" },
      status: issueStatus,
      priority: issuePriority,
      assigneeEmail: { type: "string" },
      projectId: { type: "string" },
      cycleId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
    }
  ),
  tool(
    "search_issues",
    "Full-text search issue titles and descriptions.",
    {
      query: { type: "string" },
      teamKey: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
    },
    ["query"]
  ),
  tool(
    "semantic_search_issues",
    "Find semantically similar issues using Meherah's Gemini embeddings. Requires AI access.",
    {
      text: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 20 },
    },
    ["text"]
  ),
  tool("get_issue", "Get one issue with assignee, project, cycle, labels, estimate, and due date.", { identifier: issueIdentifier }, ["identifier"]),
  tool(
    "create_issue",
    "Create a fully scoped issue in a team.",
    {
      teamKey: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      status: issueStatus,
      priority: issuePriority,
      assigneeEmail: { type: "string" },
      projectId: { type: "string" },
      cycleId: { type: "string" },
      parentIdentifier: issueIdentifier,
      estimate: { type: "number" },
      dueDate: { type: "number", description: "Unix epoch milliseconds" },
      labelIds: { type: "array", items: { type: "string" } },
    },
    ["teamKey", "title"]
  ),
  tool(
    "update_issue",
    "Update any supported issue fields. Null clears nullable fields.",
    {
      identifier: issueIdentifier,
      title: { type: "string" },
      description: nullableString,
      status: issueStatus,
      priority: issuePriority,
      assigneeEmail: nullableString,
      projectId: nullableString,
      cycleId: nullableString,
      estimate: nullableNumber,
      dueDate: nullableNumber,
    },
    ["identifier"]
  ),
  tool("delete_issue", "Delete an issue where the existing Meherah backend supports deletion.", { identifier: issueIdentifier }, ["identifier"]),
  tool("assign_issue", "Assign an issue by member email, or pass null to unassign.", { identifier: issueIdentifier, assigneeEmail: nullableString }, ["identifier", "assigneeEmail"]),
  tool("set_issue_status", "Change an issue status.", { identifier: issueIdentifier, status: issueStatus }, ["identifier", "status"]),
  tool("set_issue_priority", "Change an issue priority.", { identifier: issueIdentifier, priority: issuePriority }, ["identifier", "priority"]),
  tool("set_issue_estimate", "Set an issue estimate, or null to clear.", { identifier: issueIdentifier, estimate: nullableNumber }, ["identifier", "estimate"]),
  tool("set_issue_due_date", "Set an issue due date in Unix epoch milliseconds, or null to clear.", { identifier: issueIdentifier, dueDate: nullableNumber }, ["identifier", "dueDate"]),
  tool("list_comments", "List comments for an issue.", { identifier: issueIdentifier }, ["identifier"]),
  tool(
    "create_comment",
    "Add a comment or reply to an issue, optionally mentioning members by email.",
    {
      identifier: issueIdentifier,
      body: { type: "string" },
      mentionEmails: { type: "array", items: { type: "string" } },
      parentCommentId: { type: "string" },
    },
    ["identifier", "body"]
  ),
  tool("update_comment", "Edit your own comment.", { commentId: { type: "string" }, body: { type: "string" } }, ["commentId", "body"]),
  tool("delete_comment", "Delete your own comment; workspace admins may delete any workspace comment.", { commentId: { type: "string" } }, ["commentId"]),
  tool("list_labels", "List workspace labels."),
  tool("create_label", "Create a workspace label.", { name: { type: "string" }, color: { type: "string" } }, ["name", "color"]),
  tool("add_issue_label", "Idempotently add a label to an issue.", { identifier: issueIdentifier, labelId: { type: "string" } }, ["identifier", "labelId"]),
  tool("remove_issue_label", "Idempotently remove a label from an issue.", { identifier: issueIdentifier, labelId: { type: "string" } }, ["identifier", "labelId"]),
  tool("list_projects", "List projects with live issue progress."),
  tool("get_project", "Get a project and its issues.", { projectId: { type: "string" } }, ["projectId"]),
  tool("project_summary", "Get a detailed project progress summary.", { projectId: { type: "string" } }, ["projectId"]),
  tool("project_status_report", "Report status, lead, target date, and progress for every project."),
  tool(
    "create_project",
    "Create a project while preserving plan limits.",
    {
      name: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: ["backlog", "planned", "in_progress", "paused", "completed", "canceled"] },
      leadEmail: { type: "string" },
      targetDate: { type: "number" },
      color: { type: "string" },
    },
    ["name"]
  ),
  tool(
    "update_project",
    "Update a project.",
    {
      projectId: { type: "string" },
      name: { type: "string" },
      description: nullableString,
      status: { type: "string", enum: ["backlog", "planned", "in_progress", "paused", "completed", "canceled"] },
      leadEmail: nullableString,
      targetDate: nullableNumber,
      color: nullableString,
    },
    ["projectId"]
  ),
  tool("delete_project", "Delete a project and detach its issues without deleting the issues.", { projectId: { type: "string" } }, ["projectId"]),
  tool("list_cycles", "List cycles with progress; optionally filter by team.", { teamKey: { type: "string" } }),
  tool("get_cycle", "Get a cycle and its issues.", { cycleId: { type: "string" } }, ["cycleId"]),
  tool("cycle_summary", "Get a detailed cycle progress summary.", { cycleId: { type: "string" } }, ["cycleId"]),
  tool("cycle_summary_for_team", "Summarize the current or latest cycle for a team.", { teamKey: { type: "string" } }, ["teamKey"]),
  tool(
    "create_cycle",
    "Create the next numbered cycle for a team.",
    {
      teamKey: { type: "string" },
      name: { type: "string" },
      startDate: { type: "number", description: "Unix epoch milliseconds" },
      endDate: { type: "number", description: "Unix epoch milliseconds" },
    },
    ["teamKey", "startDate", "endDate"]
  ),
  tool(
    "update_cycle",
    "Update a cycle name or dates.",
    {
      cycleId: { type: "string" },
      name: nullableString,
      startDate: { type: "number" },
      endDate: { type: "number" },
    },
    ["cycleId"]
  ),
  tool("delete_cycle", "Delete a cycle and detach its issues.", { cycleId: { type: "string" } }, ["cycleId"]),
  tool("list_issue_relations", "List relations, parent, and sub-issues for an issue.", { identifier: issueIdentifier }, ["identifier"]),
  tool(
    "create_issue_relation",
    "Relate two issues.",
    {
      identifier: issueIdentifier,
      relatedIdentifier: issueIdentifier,
      type: { type: "string", enum: ["blocks", "blocked_by", "related", "duplicate_of"] },
    },
    ["identifier", "relatedIdentifier", "type"]
  ),
  tool("delete_issue_relation", "Remove an issue relation by relation id.", { relationId: { type: "string" } }, ["relationId"]),
  tool(
    "set_issue_parent",
    "Set or clear an issue's parent. Null makes it a top-level issue.",
    { identifier: issueIdentifier, parentIdentifier: nullableString },
    ["identifier", "parentIdentifier"]
  ),
  tool(
    "standup_report",
    "Gather recent completed, created, and in-progress work by workspace member.",
    {
      teamKey: { type: "string" },
      sinceHours: { type: "number", minimum: 1, maximum: 168 },
    }
  ),
];

function convexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  return new ConvexHttpClient(url);
}

function bearerHash(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex");
}

function json(body: unknown, status = 200, modern = false) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(modern ? { "MCP-Protocol-Version": MODERN_VERSION } : {}),
    },
  });
}

function rpcResult(
  id: string | number | null | undefined,
  result: JsonObject,
  modern: boolean
) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: modern ? { resultType: "complete", ...result } : result,
  };
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function modernRequest(request: Request, body: JsonRpcRequest) {
  const headerVersion = request.headers.get("mcp-protocol-version");
  const meta = body.params?._meta;
  const metaVersion =
    meta && typeof meta === "object"
      ? (meta as JsonObject)["io.modelcontextprotocol/protocolVersion"]
      : undefined;
  return headerVersion === MODERN_VERSION || metaVersion === MODERN_VERSION;
}

function headerMismatch(request: Request, body: JsonRpcRequest) {
  if (!modernRequest(request, body) || !body.id) return null;
  const methodHeader = request.headers.get("mcp-method");
  if (methodHeader && methodHeader !== body.method) {
    return "Mcp-Method header does not match JSON-RPC method";
  }
  const expectedName =
    body.method === "tools/call" && typeof body.params?.name === "string"
      ? body.params.name
      : undefined;
  const nameHeader = request.headers.get("mcp-name");
  if (expectedName && nameHeader && nameHeader !== expectedName) {
    return "Mcp-Name header does not match request name";
  }
  return null;
}

async function authorizedTokenHash(request: Request) {
  const tokenHash = bearerHash(request);
  if (!tokenHash) return null;
  try {
    const valid = await convexClient().action(api.mcp.verifyCredential, {
      tokenHash,
    });
    return valid ? tokenHash : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const tokenHash = await authorizedTokenHash(request);
  if (!tokenHash) {
    const origin = new URL(request.url).origin;
    return Response.json(
      { error: "A valid Meherah MCP OAuth bearer credential is required" },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate":
            'Bearer resource_metadata="' +
            origin +
            '/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"',
        },
      }
    );
  }

  let body: JsonRpcRequest;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(rpcError(null, -32600, "Invalid Request"), 400);
    }
    body = parsed as JsonRpcRequest;
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return json(rpcError(body.id, -32600, "Invalid Request"), 400);
  }

  const modern = modernRequest(request, body);
  const mismatch = headerMismatch(request, body);
  if (mismatch) {
    return json(rpcError(body.id, -32020, mismatch), 400, modern);
  }

  if (
    body.method === "notifications/initialized" ||
    body.method === "notifications/cancelled"
  ) {
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  if (body.method === "server/discover") {
    return json(
      rpcResult(
        body.id,
        {
          supportedVersions: [MODERN_VERSION, LEGACY_VERSION],
          capabilities: { tools: { listChanged: false } },
          instructions:
            "Authenticated Meherah workspace tools. All reads and writes stay scoped to the workspace bound to this bearer credential.",
          ttlMs: 300000,
          cacheScope: "private",
          _meta: {
            "io.modelcontextprotocol/serverInfo": SERVER_INFO,
          },
        },
        true
      ),
      200,
      true
    );
  }

  if (body.method === "initialize") {
    const proposed =
      typeof body.params?.protocolVersion === "string"
        ? body.params.protocolVersion
        : LEGACY_VERSION;
    const protocolVersion =
      proposed === "2025-06-18" || proposed === "2025-03-26"
        ? proposed
        : LEGACY_VERSION;
    return json(
      rpcResult(
        body.id,
        {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Authenticated Meherah workspace tools. All reads and writes stay scoped to the workspace bound to this bearer credential.",
        },
        false
      )
    );
  }

  if (body.method === "ping") {
    return json(rpcResult(body.id, {}, modern), 200, modern);
  }

  if (body.method === "tools/list") {
    return json(
      rpcResult(
        body.id,
        {
          tools: TOOLS,
          ...(modern ? { ttlMs: 300000, cacheScope: "private" } : {}),
        },
        modern
      ),
      200,
      modern
    );
  }

  if (body.method === "tools/call") {
    const name = body.params?.name;
    const argumentsValue = body.params?.arguments ?? {};
    if (typeof name !== "string") {
      return json(rpcError(body.id, -32602, "Tool name is required"), 400, modern);
    }
    if (!TOOLS.some((item) => item.name === name)) {
      return json(rpcError(body.id, -32602, "Unknown tool: " + name), 400, modern);
    }
    try {
      const result = await convexClient().action(api.mcp.execute, {
        tokenHash,
        operation: name,
        input: argumentsValue,
      });
      const text = JSON.stringify(result, null, 2);
      return json(
        rpcResult(
          body.id,
          {
            content: [{ type: "text", text }],
            structuredContent:
              result && typeof result === "object" ? result : { result },
            isError: false,
          },
          modern
        ),
        200,
        modern
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Meherah tool call failed";
      return json(
        rpcResult(
          body.id,
          {
            content: [{ type: "text", text: message }],
            isError: true,
          },
          modern
        ),
        200,
        modern
      );
    }
  }

  return json(
    rpcError(body.id, -32601, "Method not found: " + body.method),
    404,
    modern
  );
}

export function GET() {
  return new Response("MCP uses authenticated HTTP POST requests.", {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}

export function DELETE() {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}
