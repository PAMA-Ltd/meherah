/** Shared OAuth redirect validation for the Next.js routes and Convex functions. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parse(uri: string): URL | null {
  try {
    const url = new URL(uri);
    if (url.username || url.password || uri.includes("#")) return null;
    return url;
  } catch {
    return null;
  }
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** Any HTTPS callback is accepted; native apps can also use HTTP loopback. */
export function isAllowedRedirectUri(uri: string): boolean {
  const url = parse(uri);
  return url !== null && (url.protocol === "https:" || isLoopbackUrl(url));
}

/** Hosted callbacks match exactly. HTTP loopback ports may vary (RFC 8252). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const a = parse(registered);
  const b = parse(requested);
  if (!a || !b || !isLoopbackUrl(a) || !isLoopbackUrl(b)) return false;
  return (
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

export function anyRedirectUriMatches(registered: string[], requested: string): boolean {
  return registered.some((uri) => redirectUriMatches(uri, requested));
}
