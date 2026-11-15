import { expect, test } from "vitest";
import {
  anyRedirectUriMatches,
  isAllowedRedirectUri,
  isLoopbackRedirect,
  redirectUriMatches,
} from "./lib/mcpRedirects";

test("keeps the ChatGPT connector callbacks working", () => {
  expect(
    isAllowedRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")
  ).toBe(true);
  expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/abc123")).toBe(
    true
  );
  expect(isAllowedRedirectUri("https://chatgpt.com/")).toBe(false);
  expect(isAllowedRedirectUri("https://evil.example.com/connector/oauth/x")).toBe(
    false
  );
});

test("accepts RFC 8252 loopback callbacks on any port", () => {
  expect(isAllowedRedirectUri("http://127.0.0.1/callback")).toBe(true);
  expect(isAllowedRedirectUri("http://127.0.0.1:49811/callback")).toBe(true);
  expect(isAllowedRedirectUri("http://localhost:8080/callback")).toBe(true);
  expect(isAllowedRedirectUri("http://localhost:8080/oauth/callback")).toBe(
    true
  );
  expect(isAllowedRedirectUri("http://[::1]:9000/callback")).toBe(true);
});

test("rejects redirect targets that are not callbacks", () => {
  // https on loopback has no certificate to present.
  expect(isAllowedRedirectUri("https://127.0.0.1/callback")).toBe(false);
  // Arbitrary paths would let a client aim the code at a real endpoint.
  expect(isAllowedRedirectUri("http://127.0.0.1/settings")).toBe(false);
  expect(isAllowedRedirectUri("http://127.0.0.1:8080/")).toBe(false);
  expect(isAllowedRedirectUri("http://127.0.0.1:8080/callback?next=/x")).toBe(
    false
  );
  expect(isAllowedRedirectUri("http://127.0.0.1:8080/callback#frag")).toBe(false);
  // Non-loopback hosts stay out even with a callback-shaped path.
  expect(isAllowedRedirectUri("http://evil.example.com/callback")).toBe(false);
  expect(isAllowedRedirectUri("http://10.0.0.5/callback")).toBe(false);
  expect(isAllowedRedirectUri("not a url")).toBe(false);
  expect(isLoopbackRedirect("https://chatgpt.com/connector/oauth/x")).toBe(false);
});

test("accepts Codex callbacks with a listener-specific path", () => {
  expect(
    isAllowedRedirectUri("http://127.0.0.1:58564/callback/uk3qVqzskXBg")
  ).toBe(true);
  expect(isAllowedRedirectUri("http://localhost:8080/callback/abc_123-x")).toBe(true);
  expect(isAllowedRedirectUri("http://[::1]:9000/callback/abc123")).toBe(true);
});

test("rejects malformed or remote Codex callback paths", () => {
  for (const uri of [
    "http://127.0.0.1:8080/callback/",
    "http://127.0.0.1:8080/callback/a/b",
    "http://127.0.0.1:8080/callback/a%2Fb",
    "http://127.0.0.1:8080/callback/abc?next=/x",
    "http://127.0.0.1:8080/callback/abc#fragment",
    "http://evil.example.com/callback/abc",
    "https://127.0.0.1:8080/callback/abc",
  ]) {
    expect(isAllowedRedirectUri(uri), uri).toBe(false);
  }
});

test("matches Codex callbacks across ports while preserving the callback ID and host", () => {
  const registered = "http://127.0.0.1:1234/callback/uk3qVqzskXBg";
  expect(redirectUriMatches(registered, "http://127.0.0.1:4321/callback/uk3qVqzskXBg")).toBe(true);
  expect(redirectUriMatches(registered, "http://127.0.0.1:1234/callback/another-id")).toBe(false);
  expect(redirectUriMatches(registered, "http://localhost:1234/callback/uk3qVqzskXBg")).toBe(false);
  expect(redirectUriMatches(registered, "http://127.0.0.1:1234/callback")).toBe(false);
});

test("matches loopback URIs across ports but not across hosts", () => {
  expect(
    redirectUriMatches("http://127.0.0.1:1234/callback", "http://127.0.0.1:4321/callback")
  ).toBe(true);
  expect(
    redirectUriMatches("http://127.0.0.1/callback", "http://127.0.0.1:4321/callback")
  ).toBe(true);
  // localhost and 127.0.0.1 are different origins and must not be conflated.
  expect(
    redirectUriMatches("http://127.0.0.1:1234/callback", "http://localhost:1234/callback")
  ).toBe(false);
  // A different path is a different target.
  expect(
    redirectUriMatches("http://127.0.0.1:1234/callback", "http://127.0.0.1:1234/oauth/callback")
  ).toBe(false);
});

test("keeps non-loopback matching byte for byte", () => {
  const chatgpt = "https://chatgpt.com/connector_platform_oauth_redirect";
  expect(redirectUriMatches(chatgpt, chatgpt)).toBe(true);
  expect(redirectUriMatches(chatgpt, chatgpt + "/")).toBe(false);
  expect(
    anyRedirectUriMatches(
      [chatgpt, "http://127.0.0.1:5555/callback"],
      "http://127.0.0.1:6666/callback"
    )
  ).toBe(true);
  expect(anyRedirectUriMatches([chatgpt], "http://127.0.0.1:6666/callback")).toBe(
    false
  );
});
