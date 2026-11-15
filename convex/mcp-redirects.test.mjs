import { expect, test } from "vitest";
import { anyRedirectUriMatches, isAllowedRedirectUri, redirectUriMatches } from "./lib/mcpRedirects";

test.each([
  "https://agent.meta.ai/api/hatch/oauth/callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/abc123",
  "https://new-client.example/custom/return?client=mcp",
  "https://another-client.example:8443/",
  "http://127.0.0.1:58564/callback/uk3qVqzskXBg",
  "http://localhost:8080/any/path?client=mcp",
  "http://[::1]:9000/oauth/return",
])("accepts a callback without a provider allowlist: %s", (uri) => {
  expect(isAllowedRedirectUri(uri)).toBe(true);
});

test.each([
  "not a url",
  "/relative/callback",
  "javascript:alert(1)",
  "data:text/html,callback",
  "http://remote-client.example/callback",
  "http://localhost.evil.example/callback",
  "http://10.0.0.5/callback",
  "https://client.example/callback#fragment",
  "https://user:password@client.example/callback",
  "http://user@localhost:8080/callback",
])("rejects an invalid OAuth callback: %s", (uri) => {
  expect(isAllowedRedirectUri(uri)).toBe(false);
});

test("keeps hosted callbacks bound to the exact registered URI", () => {
  const registered = "https://agent.meta.ai/api/hatch/oauth/callback";
  expect(redirectUriMatches(registered, registered)).toBe(true);
  for (const requested of [
    registered + "/", registered + "?next=/x", registered + "#fragment",
    "https://other.example/api/hatch/oauth/callback",
    "https://agent.meta.ai:8443/api/hatch/oauth/callback",
  ]) {
    expect(redirectUriMatches(registered, requested), requested).toBe(false);
  }
});

test("ignores only the port for loopback callbacks", () => {
  const registered = "http://127.0.0.1:1234/return/abc?client=mcp";
  expect(redirectUriMatches(registered, "http://127.0.0.1:4321/return/abc?client=mcp")).toBe(true);
  for (const requested of [
    "http://localhost:1234/return/abc?client=mcp",
    "http://127.0.0.1:1234/return/other?client=mcp",
    "http://127.0.0.1:1234/return/abc?client=other",
    "http://127.0.0.1:1234/return/abc",
  ]) {
    expect(redirectUriMatches(registered, requested), requested).toBe(false);
  }
});

test("matches only a registered callback from the client's list", () => {
  const registered = ["https://client.example/callback", "http://localhost:1234/return"];
  expect(anyRedirectUriMatches(registered, "http://localhost:4321/return")).toBe(true);
  expect(anyRedirectUriMatches(registered, "https://another.example/callback")).toBe(false);
});
