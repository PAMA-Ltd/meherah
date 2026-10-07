# Configuring Meherah

Everything needed to get a Meherah deployment running: app setup (Clerk +
Convex + env vars) first, then the GitHub integration.

## App setup

### Prerequisites

- Node.js 18+ and pnpm
- Accounts on [Clerk](https://clerk.com), [Convex](https://convex.dev), [Google AI Studio](https://aistudio.google.com), and [Mailjet](https://www.mailjet.com)

### 1. Install

```bash
pnpm install
```

### 2. Environment variables

Create `.env.local` in the project root (see `.env.example`):

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_FRONTEND_API_URL=https://your-instance.clerk.accounts.dev

NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/onboarding
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/onboarding

CONVEX_DEPLOYMENT=dev:your-deployment
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://your-deployment.convex.site
```

Never commit `.env.local`.

### 3. Configure Clerk

1. Create a Clerk application and copy the keys into `.env.local`
2. Enable Organizations
3. Create a JWT template named exactly `convex` with these claims:

```json
{
  "org_id": "{{org.id}}",
  "org_slug": "{{org.slug}}",
  "org_role": "{{org.role}}"
}
```

4. Set up Billing with three organization plans: `free_org`, `pro`, `enterprise`
5. Attach features to the paid plans: `ai_agent`, `unlimited_projects`, `unlimited_issues`, `unlimited_seats`, `unlimited_ai`, `priority_support`
6. Copy your plan IDs into [`lib/plans.ts`](../lib/plans.ts)
7. Set each plan's member limit and seat pricing - see below

#### How seats are enforced

Seats are the one limit Convex cannot enforce. Invitations go straight from
the browser to Clerk via `organization.inviteMember()`, so no Convex
mutation is ever in the path.

The cap therefore lives on the Clerk plan itself. Each plan has a **Limit
organization members** setting that applies to every organization on that
plan, so nothing has to sync it and a new workspace is capped correctly from
the moment it is created.

| Plan       | Limit organization members | Per-seat fee | Included seats |
| ---------- | -------------------------- | ------------ | -------------- |
| Free       | Custom limit, 3            | off          | n/a            |
| Pro        | Custom limit, 10           | $5.00/month  | 3              |
| Enterprise | Unlimited members          | off          | n/a            |

**On a seat-based plan the limit is seats bought, not the plan ceiling.**
Attach a per-seat fee and the plan's member limit stops acting as a grant.
Each organization may have exactly as many members as it has paid seats, and
the Backend API refuses to change that number.

This matters because Clerk does not bill for an extra member automatically.
It refuses the invitation:

```
You have reached your limit of 3 organization memberships,
including outstanding invitations.
```

Measured on live Pro organizations, caps sat at 1, 2 and 3 while the pricing
page advertised 10. The seat has to be bought before anyone can be invited
into it.

That purchase is what [`components/billing/seat-manager.tsx`](../components/billing/seat-manager.tsx)
provides. It reads the paid seat count from `useSubscription({ for:
"organization" })` and hands the purchase to Clerk's own checkout drawer via
`<CheckoutButton seatsQuantity>`, which prices the change and prorates it for
the remainder of the billing period. `seatsQuantity` is the total to end up
with, not the number being added.

The members page gates invitations on that same paid count rather than on
`maxSeats`, so the form matches what Clerk will accept, and offers "Add
seats" instead of "Upgrade" while the plan still has room.

Two things to know:

- These numbers are mirrored for display in [`lib/plans.ts`](../lib/plans.ts)
  and in `FREE_PLAN_LIMITS` in [`convex/lib/limits.ts`](../convex/lib/limits.ts).
  Nothing enforces that they agree with the Dashboard, so change them together.
- Nothing may set `max_allowed_memberships` on a seat-based plan's
  organizations. Clerk owns that number and rejects the write:

  ```
  400 organization_member_limit_managed_by_billing
  This organization's member limit is managed by their subscription.
  It cannot be edited directly.
  ```

  This is why an earlier `convex/clerkSeats.ts` was removed: seats are
  bought, not assigned. Seeing this error means something is still trying to
  assign them.
- An organization keeps whatever seat count it has paid for. Raising it is a
  purchase, made by an admin through the seat manager on the billing page,
  not an administrative change.

### 4. Configure Convex

Run `npx convex dev` to create or link a project, then set env vars on the deployment:

```bash
npx convex env set CLERK_FRONTEND_API_URL https://your-instance.clerk.accounts.dev
npx convex env set CLERK_WEBHOOK_SECRET whsec_...
npx convex env set GEMINI_API_KEY <gemini api key>\nnpx convex env set MAILJET_API_KEY <mailjet api key>\nnpx convex env set MAILJET_SECRET_KEY <mailjet secret key>\nnpx convex env set MAILJET_FROM_EMAIL notifications@example.com\nnpx convex env set MAILJET_FROM_NAME Meherah
```

No `CLERK_SECRET_KEY` here. Convex never calls the Clerk Backend API: it
only receives webhooks, which are verified with `CLERK_WEBHOOK_SECRET`
above. The Next.js app needs `CLERK_SECRET_KEY` in its own environment, and
that is already covered in step 1.

### 5. Configure Clerk webhooks

1. In Clerk, create a webhook endpoint pointing to `https://your-deployment.convex.site/clerk-webhook` (note `.convex.site`, not `.convex.cloud`)
2. Subscribe to `user.*`, `organization.*`, `organizationMembership.*`, and all `subscription.*` / `subscriptionItem.*` events
3. Copy the signing secret into the Convex env var `CLERK_WEBHOOK_SECRET`

### 6. Run

```bash
pnpm dev
```

Runs Next.js and Convex in parallel. Open [http://localhost:3000](http://localhost:3000), sign up, create an organization, and you are in.

### Deployment

1. Deploy the frontend to [Vercel](https://vercel.com) and add all `.env.local` variables
2. Run `npx convex deploy` and set `CLERK_FRONTEND_API_URL`, `CLERK_WEBHOOK_SECRET`, `GEMINI_API_KEY`, and the `MAILJET_*` variables on the production Convex deployment
3. Point the Clerk webhook at the production Convex HTTP URL and switch to production Clerk keys
4. Configure the member limit and seat pricing on each plan in the
   production Clerk instance. Plan settings do not carry over from
   development, so a production instance starts with no member limits
5. Test end to end: sign up, create org, create issue, upgrade plan, AI chat

### Troubleshooting

| Problem                                  | Fix                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| "Not authenticated" errors from Convex   | JWT template must be named exactly `convex`; set `CLERK_FRONTEND_API_URL` on Convex  |
| Org pages 404 or redirect to onboarding  | JWT template needs `org_id` / `org_slug` / `org_role` claims and an active org       |
| Webhook returns 400                      | Signing secret must match `CLERK_WEBHOOK_SECRET` (not `CLERK_SECRET_KEY`)            |
| User missing in Convex after sign-up     | Webhook URL must end with `/clerk-webhook` on the `.convex.site` domain              |
| Plan not updating after checkout         | Subscribe to all `subscription.*` and `subscriptionItem.*` webhook events            |
| AI chat errors immediately               | Set `GEMINI_API_KEY` on the Convex deployment                                        |
| Convex types not updating                | Keep `npx convex dev` running                                                        |

---

## GitHub integration

Meherah's GitHub integration is a [GitHub App](https://docs.github.com/en/apps).
Creating the app is a one-time step per deployment; after that, every
workspace connects itself with one click (Settings → Integrations → Connect)
and picks which repositories to grant.

### 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

Your Convex site URL is the `NEXT_PUBLIC_CONVEX_SITE_URL` value in
`.env.local` (e.g. `https://your-deployment.convex.site` - note `.site`,
not `.cloud`).

| Field | Value |
| --- | --- |
| GitHub App name | `Meherah` (any unique name works - only the slug matters) |
| Description | see below |
| Homepage URL | your app URL, e.g. `http://localhost:3000` |
| Callback URL | leave empty (no OAuth identity is requested) |
| Request user authorization (OAuth) during installation | unchecked |
| Enable Device Flow | unchecked |
| Setup URL | `<convex-site-url>/github-setup` |
| Redirect on update | **unchecked** (repo changes sync via webhook) |
| Webhook → Active | checked |
| Webhook URL | `<convex-site-url>/github-webhook` |
| Webhook secret | a long random string - you set the same value on Convex below |
| Repository permissions | **Pull requests: Read-only** (Metadata read is added automatically) |
| Subscribe to events | **Pull request** (installation events are delivered automatically) |
| Where can this app be installed? | "Only on this account" is fine; "Any account" if other GitHub orgs need it |

Suggested description:

> Meherah is an AI-native issue tracker for teams that plan, track, and ship
> together. This app links pull requests to Meherah issues: mention an issue
> key like ENG-42 in a branch name, PR title, or description and Meherah
> attaches the PR to that issue and keeps its status in sync - opened PRs
> move issues to In Review, merged PRs mark them Done.

Generate a webhook secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For GitHub **Issues** sync (creating issues in repos from Meherah), also add
under Repository permissions: **Issues: Read and write**. Then, on the app
page after creation, note the **App ID** and generate a **private key**
("Private keys" → Generate) - a `.pem` file downloads.

For **two-way sync** (GitHub → Meherah: edits, close/reopen, and comments on
the linked GitHub issue reflected back), additionally subscribe to the
**Issues** and **Issue comment** events. Events from bots (including the
app itself) are ignored to prevent echo loops.

---

## Figma integration

Lets members paste Figma file/frame links on issues; Meherah fetches the
design's name and a rendered thumbnail via the Figma REST API.

1. Create an OAuth app at [figma.com/developers/apps](https://www.figma.com/developers/apps)
   with redirect URI `<convex-site-url>/figma-callback`, and under the app's
   **OAuth scopes** enable `file_content:read`, `file_metadata:read`,
   `file_comments:write`, `file_versions:read`, and
   `file_dev_resources:write` (Meherah requests exactly these). Changing
   scopes later requires clicking Connect again to mint a new token.
2. Set the credentials on Convex:

```bash
npx convex env set FIGMA_CLIENT_ID <client id>
npx convex env set FIGMA_CLIENT_SECRET <client secret>
```

3. In Meherah: Settings → Integrations → Figma → **Connect** (workspace
   admins only). Figma asks for read-only file access and redirects back.
4. On any issue: sidebar → Figma → **+** → paste a link (or just paste a
   figma.com URL into a description or comment - it auto-attaches). The
   name, thumbnail, and "edited Xh ago" freshness stamp fill in a moment
   later; OAuth tokens are refreshed automatically when they expire.

What the integration does once connected:

- **Previews**: design name, rendered thumbnail, and last-edited time on
  each link card (↻ in the panel header re-fetches).
- **Comment to Figma**: the issue comment composer gains an "Also post to
  Figma" checkbox; the comment lands on the linked design (pinned to the
  frame for node links) as "Name via Meherah ENG-42: …".
- **Dev Mode resources**: frame links push a resource onto the frame in
  Figma Dev Mode - "ENG-42 · In Progress · Title" linking back to the
  Meherah issue - renamed automatically when the status/title changes and
  removed when the link is removed. Requires `SITE_URL` to be set for the
  link to point at your app.

### 2. Set Convex environment variables

The app slug is in the app page URL: `github.com/settings/apps/<slug>`.

```bash
npx convex env set GITHUB_APP_SLUG <slug>
npx convex env set GITHUB_WEBHOOK_SECRET <webhook secret from step 1>
# For GitHub Issues sync (issue creation from Meherah):
npx convex env set GITHUB_APP_ID <numeric app id>
# REQUIRED - your app's public origin. Used for OAuth redirects after a
# GitHub/Figma connect, links inside email digests, and the resources
# pushed into Figma Dev Mode. Sending fails loudly when it is unset
# rather than silently emitting http://localhost:3000 links.
npx convex env set SITE_URL https://your-app.example.com
```

The private key is multiline and shells tend to truncate multiline env
values, so store it base64-encoded (the backend accepts raw PEM, \n-escaped
PEM, or base64):

```powershell
# PowerShell
npx convex env set GITHUB_PRIVATE_KEY ([Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\key.pem")))
```

```bash
# bash
npx convex env set GITHUB_PRIVATE_KEY "$(base64 -w0 path/to/key.pem)"
```

Keep the `.pem` outside the repo - especially never in `public/`, which is
served verbatim by Next.js.

### 3. Connect a workspace

In Meherah: Settings → Integrations → **Connect** (workspace admins only).
GitHub opens its install screen where you select one, several, or all
repositories, then redirects you back to the settings page. The granted
repositories appear as chips and can be changed any time from the GitHub
App's installation settings - the list re-syncs automatically.

### How it works

- **Connect** mints a single-use nonce (valid 15 minutes) bound to your
  workspace and user, and sends you to
  `github.com/apps/<slug>/installations/new?state=<nonce>`.
- After you pick repositories, GitHub redirects to
  `<convex-site>/github-setup?installation_id=…&state=<nonce>`. Meherah
  verifies the nonce and stores the installation id against the workspace -
  that's the entire binding; no tokens or private keys are stored.
- GitHub then delivers webhooks (HMAC-signed with the app secret) to
  `<convex-site>/github-webhook`:
  - `installation` / `installation_repositories` events keep the granted
    repository list in sync (and disconnect the workspace if the app is
    uninstalled on GitHub).
  - `pull_request` events are scanned for issue identifiers (`ENG-42`) in
    the branch name, PR title, and body. Each referenced issue gets the PR
    attached (visible on the issue's detail sidebar), and statuses move:
    opened/reopened PR → **In Review** (from backlog/todo/in progress),
    merged PR → **Done**. Every transition writes the activity log and
    notifies the issue's creator and assignee in their inbox.
- The enable/disable switch in Settings → Integrations pauses event
  processing without disconnecting; Disconnect removes the binding but
  keeps already-linked PRs on their issues.
- **Projects ↔ repositories**: a project's Properties panel lists connected
  repositories (owner, name, Public/Private) and a picker fetched live from
  the installation. Connection is optional.
- **Issue sync**: when a new issue's project has connected repositories,
  the create dialog offers "Also create this issue on GitHub" with a repo
  choice. The issue is always created in Meherah first; a scheduled action
  then creates the GitHub twin (via an app JWT → installation token) and
  records the link, which appears in the issue's GitHub panel and activity
  timeline.
- **System actor**: all automated events (issue sync, PR-driven status
  changes) appear in timelines and the inbox as **GitHub** with the GitHub
  logo - never as a workspace user. Failures are recorded on the timeline
  too ("couldn't sync this issue to GitHub").

## AI models (Gemini)

Meherah uses one Google Gemini API key for every AI surface. Set this on the
Convex deployment:

```bash
npx convex env set GEMINI_API_KEY <your Gemini API key>
```

The provider configuration is centralized in
[`convex/agent/models.ts`](../convex/agent/models.ts):

- Chat/agent model: `gemini-3.8-flash`
- Semantic embedding model: `gemini-embedding-2`
- Provider endpoint: Google's OpenAI-compatible Gemini endpoint

The existing Convex Agent tools, AI drafting, triage, reports, semantic search,
and duplicate detection all use that single provider configuration.

### Embedding migration

The existing Convex vector index remains at 4096 dimensions. Gemini Embedding 2
vectors are padded with deterministic zero dimensions before they are written,
which preserves cosine similarity while avoiding a destructive vector-index
migration. Each issue also stores the embedding model marker.

When an AI surface opens, `ensureOrgEmbeddings` automatically finds issues
whose embeddings are missing or still marked as a legacy provider and
re-embeds them in background batches. There is no NVIDIA key or one-off
clear-embeddings script to run.

---

## Email digests (Mailjet)

Digest scheduling, per-member timezone handling, content selection, the HTML
template, and the hourly Convex cron are unchanged. Delivery and test emails
use Mailjet's v3.1 Send API from
[`convex/email/sendDigest.ts`](../convex/email/sendDigest.ts).

Set these on the Convex deployment:

```bash
npx convex env set MAILJET_API_KEY <api key>
npx convex env set MAILJET_SECRET_KEY <secret key>
npx convex env set MAILJET_FROM_EMAIL notifications@example.com
npx convex env set MAILJET_FROM_NAME Meherah
```

`MAILJET_FROM_NAME` is optional and defaults to `Meherah`. The first three
variables are required. The sender address/domain must be validated in your
Mailjet account.

Links inside digest emails continue to come from `SITE_URL`.

Testing:

```bash
npx convex run email/sendDigest:testTo '{"to":"you@example.com"}'
```

The Mail settings page's existing Send test action also uses Mailjet now.
There are no SMTP host/user/password variables.

---

## MCP server

Meherah exposes a remote MCP server from the same Next.js deployment:

```text
https://<your-meherah-domain>/api/mcp
```

There is no second app, deployment, or MCP-specific environment secret. When
the Meherah web app is online, the MCP endpoint is online.

### ChatGPT authentication

ChatGPT uses Meherah's built-in OAuth 2.1 + PKCE flow. OAuth discovery is
published from the same deployment, and ChatGPT can dynamically register a
public client. The user signs in with the normal Clerk session, chooses the
active Meherah workspace, reviews the requested permissions, and authorizes
the connection.

The OAuth flow issues:

- one-hour bearer access tokens;
- rotating refresh tokens;
- `mcp:read` / `mcp:write` scopes;
- credentials bound to the authorizing Meherah user and active workspace.

Raw access and refresh tokens are never stored. Convex stores SHA-256 hashes,
and every MCP request re-checks that the credential is not expired or revoked
and that the user is still a member of the bound workspace.

To connect ChatGPT, create a custom MCP app/server and use the URL above with
OAuth authentication. No manual MCP API key is needed for ChatGPT.

### Manual bearer credentials

Non-ChatGPT MCP/API clients can still use a one-time bearer credential. The
Clerk-protected management endpoint is `/api/mcp/credentials`:

- `POST` with optional `{"name":"CLI","expiresAt":<epoch-ms>}` creates a credential and returns the raw secret once.
- `GET` lists the current user's credentials without secrets.
- `DELETE` with `{"credentialId":"..."}` revokes one immediately.

Manual client configuration:

```text
URL: https://<your-meherah-domain>/api/mcp
Authorization: Bearer <one-time credential>
```

The MCP transport supports current stateless discovery as well as
initialize-based clients. Tool calls are organization-scoped, enforce live
membership and plan limits, and expose read/write hints plus destructive-action
annotations for MCP hosts.
