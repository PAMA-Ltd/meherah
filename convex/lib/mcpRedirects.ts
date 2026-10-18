/**
 * Redirect URI policy for the Meherah MCP OAuth server.
 *
 * Clients register dynamically, so registration has to decide which redirect
 * targets are safe to hand an authorization code to. Two families qualify:
 *
 * - the ChatGPT connector callbacks the server launched with, which bounce the
 *   code back to chatgpt.com;
 * - RFC 8252 loopback redirects (`http://127.0.0.1/callback`), where the native
 *   MCP host runs a throwaway listener on the user's own machine. Hosts such as
 *   OpenCode, Claude Code, and Codex CLI use these.
 *
 * Loopback ports are ephemeral, so a registered loopback URI and the requested
 * one usually differ by port only. `redirectUriMatches` ignores the port for
 * loopback hosts, which is exactly what RFC 8252 section 7.3 asks of a server.
 * It deliberately does not ignore the host or path: `localhost` and `127.0.0.1`
 * stay distinct, so a code issued for one is never accepted for the other.
 *
 * Imports must stay inside `convex/`, because Convex bundles these functions
 * separately from the Next.js app. `lib/mcp-oauth.ts` imports this module too so
 * both sides share one policy.
 */

/** Path families the ChatGPT connector registers. */
const CHATGPT_HOSTNAME = "chatgpt.com";
const CHATGPT_PATH_PREFIX = "/connector/oauth/";
const CHATGPT_REDIRECT_PATH = "/connector_platform_oauth_redirect";

/** Callback paths recommended by RFC 8252 section 7.3 for native apps. */
const LOOPBACK_CALLBACK_PATHS = new Set(["/callback", "/oauth/callback"]);

/** Host literals that mean "this machine". `URL` keeps IPv6 brackets. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/** True for `https://chatgpt.com/connector/...` connector callbacks. */
export function isChatGptRedirect(uri: string): boolean {
  const url = parse(uri);
  if (!url) return false;
  return (
    url.protocol === "https:" &&
    url.hostname === CHATGPT_HOSTNAME &&
    (url.pathname.startsWith(CHATGPT_PATH_PREFIX) ||
      url.pathname === CHATGPT_REDIRECT_PATH)
  );
}

/**
 * True for an RFC 8252 loopback listener. Plain `http` is required, not
 * `https`: the host holds no certificate for `127.0.0.1`, and requiring TLS
 * here is a common source of silent native-app failures.
 */
export function isLoopbackRedirect(uri: string): boolean {
  const url = parse(uri);
  if (!url) return false;
  if (url.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
  // Query strings and fragments would make the stored URI ambiguous to match.
  if (url.search || url.hash) return false;
  return LOOPBACK_CALLBACK_PATHS.has(url.pathname);
}

/** True when the URI may be registered as a dynamic client redirect target. */
export function isAllowedRedirectUri(uri: string): boolean {
  return isChatGptRedirect(uri) || isLoopbackRedirect(uri);
}

/**
 * True when `requested` may reuse a code registered for `registered`.
 *
 * Exact matches always pass. Loopback pairs differ only by port, so compare
 * scheme, host, and path. Everything else must match byte for byte.
 */
export function redirectUriMatches(
  registered: string,
  requested: string
): boolean {
  if (registered === requested) return true;
  if (!isLoopbackRedirect(registered) || !isLoopbackRedirect(requested)) {
    return false;
  }
  const a = parse(registered);
  const b = parse(requested);
  if (!a || !b) return false;
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname
  );
}

/** True when any registered URI may reuse a code for `requested`. */
export function anyRedirectUriMatches(
  registered: string[],
  requested: string
): boolean {
  return registered.some((uri) => redirectUriMatches(uri, requested));
}
