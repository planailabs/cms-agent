# Setup

## Prerequisites

- Node 22 + pnpm 11 (or `nix develop`)
- PostgreSQL (production; tests use a throwaway SQLite automatically)
- An OIDC identity provider (Keycloak, Authentik, Dex, Google, …)
- Any OpenAI-compatible model endpoint
- The target Astro site as a local git repository with its own
  `node_modules` installed (the CMS runs `npx astro dev` inside it)

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | yes | ≥16 chars, session signing |
| `BETTER_AUTH_URL` | yes | Public URL of the CMS (e.g. `https://cms.example.com`) |
| `OIDC_ISSUER` | yes | Issuer URL; discovery via `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | yes | OAuth client for the CMS |
| `ALLOWED_EMAILS` | no | Comma-separated sign-in allowlist |
| `ALLOWED_EMAIL_DOMAIN` | no | Domain allowlist (e.g. `example.com`) |
| `OPENAI_BASE_URL` | yes | OpenAI-compatible API base (e.g. `https://api.openai.com/v1`) |
| `OPENAI_API_KEY` | yes | API key for that endpoint |
| `OPENAI_MODEL` | yes | Model name |
| `OPENAI_MAX_TOKENS` | no | Response cap (default 4096) |
| `BASE_DOMAIN` | yes | CMS domain; previews live at `<branch>.BASE_DOMAIN` |
| `HOST` / `PORT` | no | Internal CMS bind (default 127.0.0.1:4321) |
| `PREVIEW_COOKIE_SECRET` | yes | HMAC secret shared with the proxy sidecar |
| `REPO_PATH` | yes | Path to the managed Astro site git repo |
| `REPO_DEV_COMMAND` | no | Default `npx astro dev` (split on spaces, no shell) |
| `REPO_BUILD_COMMAND` | no | Default `npx astro build` |
| `ROUTE_MAPPINGS` | no | JSON `[{"files":"src/content/blog/*.md","route":"/blog/:slug/"}]` for the visual diff |
| `DEPLOY_FLOW` | no | `git-push` (default) \| `web-agency` \| `github-ci` \| `cloudflare-pages` |
| `DEPLOY_GIT_REMOTE` | flow | Remote for git-push / github-ci (default `origin`) |
| `PUBLISH_COMMAND` | flow | web-agency script; receives `TARBALL_PATH`, `DIST_DIR`, `GIT_SHA` (runs through a shell) |
| `GITHUB_TOKEN` / `GITHUB_REPO` | flow | github-ci check polling (`owner/repo`) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_PAGES_PROJECT` | flow | cloudflare-pages direct upload |
| `VAR_DIR` | yes | Runtime state: worktrees, previews, artifacts, uploads, proxy files |
| `INPUT_TOKEN_BUDGET_PER_HOUR` / `OUTPUT_TOKEN_BUDGET_PER_HOUR` | no | Per-user hourly budgets (0 = unlimited) |
| `PREVIEW_IDLE_TIMEOUT_MS` | no | Stop idle previews (default 10 min) |
| `PREVIEW_MAX_INSTANCES` | no | LRU cap on running previews (default 5) |

Proxy sidecar (own process, `proxy/`): `PROXY_LISTEN` (default `0.0.0.0:8080`),
`BASE_DOMAIN`, `VAR_DIR` (same as the CMS), `PREVIEW_COOKIE_SECRET`,
`PREVIEW_REQUIRE_AUTH` (default true; set `false` for `localhost`, where
domain cookies don't work), `PUBLIC_SCHEME`, `CMS_UPSTREAM` — see
`proxy/README.md`.

## DNS

Point `BASE_DOMAIN` **and** `*.BASE_DOMAIN` at the proxy sidecar. The CMS
itself should only listen on localhost.

## First user / admin

Users are created on first OIDC sign-in (gated by the allowlist). Promote the
first admin directly: `UPDATE "user" SET role='admin' WHERE email='…';`
Afterwards the dashboard manages roles.

## NixOS note (development)

Prisma CLI needs the nixpkgs engines: `source scripts/prisma-env.sh` (the
flake dev shell does this automatically).
