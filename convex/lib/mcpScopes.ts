/** Scopes issued after the user approves an MCP connection. */
export function authorizationScopes(requested: string[]): string[] {
  return [...new Set(["mcp:read", "mcp:write", ...requested])];
}
