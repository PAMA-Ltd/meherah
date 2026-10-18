import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/pricing(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Read-only public issue share links (token-gated in the Convex query).
  "/share(.*)",
  // MCP transport and OAuth machine endpoints authenticate inside the routes.
  "/api/mcp",
  "/api/mcp/oauth/register",
  "/api/mcp/oauth/token",
  "/api/mcp/oauth/revoke",
  // Consent screen and its form target: both check the Clerk session
  // themselves, so they stay public here. Protecting them in middleware would
  // drop the OAuth request parameters before the route could read them.
  "/mcp/authorize",
  "/api/mcp/oauth/authorize/confirm",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|txt|md|xml|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
