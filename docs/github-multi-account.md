# GitHub account connections

A workspace can connect a personal GitHub account and one or more GitHub
organizations. Each installation has its own enabled state, repository list,
and disconnect control. Adding an account preserves existing connections.
Repository pickers combine the enabled accounts. Issue and attachment sync use
the installation that grants the target repository, rather than the first
connected account.

Each repository also has an independent sync toggle. Turning it off excludes
it from repository pickers and pauses inbound issue/PR events and outbound
issue/attachment updates. Existing links stay on their issues. Repository
refreshes and account pauses preserve these choices. All repositories start
off, including newly granted repositories; turn on only those you want to sync.
Only workspace admins can change either account or repository toggles.
These preferences pause Meherah sync; repository permissions are managed on GitHub.

Existing records remain valid; a missing `disabledRepositories` field means all
repositories are off until the admin opts in. No backfill is needed.
No new GitHub environment variables are required. An installation can belong to only
one Meherah workspace; a different workspace cannot claim it.

After deployment, connect each additional account using **Connect another account**
in the workspace's integration settings. Installing the GitHub App directly
does not associate it with a Meherah workspace: start from Meherah so the setup
callback includes its single-use state. For an already-installed account,
GitHub may open its configuration page instead; uninstall and reinstall that
account from Meherah's connect flow if GitHub does not return to Meherah.
For a different personal account, sign into that account on GitHub before
continuing the installation flow. GitHub's account picker also lists the
organizations where that user can install the app.

## Deployment hold

Do not deploy or push a branch that triggers automatic production deployment
until the owner has supplied all required environment values.

The pulled main branch requires these values on Convex:

- `GEMINI_API_KEY` for the new AI provider.
- `MAILJET_API_KEY` and `MAILJET_SECRET_KEY` for email delivery.
- `MAILJET_FROM_EMAIL`, a Mailjet-verified sender address.
- `MAILJET_FROM_NAME` is optional; the default is `Meherah`.

Preserve the existing Clerk, site-origin, and GitHub deployment values. GitHub
requires `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and
`GITHUB_WEBHOOK_SECRET`. Figma credentials are optional unless that integration
is being enabled. Store secrets in ignored environment files or the deployment
environment; never commit them.

## Local checks

Run `pnpm exec tsc --noEmit` and `pnpm lint`.

The regression suite uses Vitest, convex-test, and the edge runtime. To avoid
editing the frozen application package files, the test tooling can be installed
in a temporary directory:

```powershell
$taskTestRuntime = Join-Path $env:TEMP 'meherah-convex-tests'
npm install --prefix $taskTestRuntime --no-audit --no-fund convex-test@0.0.60 vitest@5.0.3 @edge-runtime/vm@5.0.0
$env:MEHERAH_TEST_RUNTIME = $taskTestRuntime
node (Join-Path $taskTestRuntime 'node_modules/vitest/vitest.mjs') run --config vitest.config.mjs
```

These tests use a simulated Convex backend and synthetic GitHub responses.
They do not require production credentials or deploy any functions.
