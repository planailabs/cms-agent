---
layout: ../../components/architecture/Shell.astro
title: Setup
lead: Prerequisites, configuration, DNS, the first admin, and how to run it in development.
---

## Prerequisites

- Node 22 + pnpm 11 + Rust toolchain — or just `nix develop`, which provides
  everything (including overmind, the Prisma engines, and Playwright
  browsers) and is the recommended way to work on the project
- PostgreSQL (production; tests use a throwaway SQLite automatically)
- An OIDC identity provider (Keycloak, Authentik, Dex, Google, …)
- Any OpenAI-compatible model endpoint
- The target site as a local git repository. Its dependencies are installed
  per worktree by the preview manager, with the site's own package manager —
  nothing to prepare by hand. (The Astro dev server runs as `npx --no astro
  dev`, so a site whose dependencies are genuinely broken fails loudly
  instead of silently running a different astro.)

## Environment variables

**`.env.example` is the complete list** — every variable the app reads, with
its default and a line on what it does, grouped the way you configure them.
A test keeps it in step with the schema in `src/lib/env.ts`, so it cannot
quietly fall behind. Copy it and fill in what your deployment needs.

The ones with no sensible default, which the server refuses to start without:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | ≥16 chars, session signing |
| `BETTER_AUTH_URL` | Public URL of the CMS (e.g. `https://cms.example.com`) |
| `OIDC_ISSUER` | Issuer URL; discovery via `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | OAuth client for the CMS |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | Any OpenAI-compatible endpoint |
| `SKILL_ROUTER_MODEL` | Small model that picks the skills and MCP groups each turn is hinted with. A routing failure fails the turn — there is no full-list fallback, because a prompt that quietly grows back to every skill hides a broken router |
| `BASE_DOMAIN` | CMS domain; previews live at `<branch>.BASE_DOMAIN` |
| `REPO_PATH` | Path to the managed site git repo (a repository of its own) |
| `VAR_DIR` | Runtime state: worktrees, previews, artifacts, uploads, proxy files |
| `PROXY_NATIVE_PATH` | Path to the embedded Pingora addon — outside Nix only; Nix packages set it |

Worth knowing about the rest:

- **Deployment** is selected by `DEPLOY_FLOW` (`git-push` | `web-agency` |
  `github-ci` | `cloudflare-pages`); each flow reads its own credentials.
- **The site backend** is auto-detected (`astro.config.*` or an `astro`
  dependency → astro, else static). `SITE_BACKEND`, `REPO_DEV_COMMAND` and
  `REPO_BUILD_COMMAND` override that.
- **The sandbox** (`SANDBOX_*`) has working defaults everywhere; production
  refuses `SANDBOX_MODE=none`.
- **Budgets** (`*_TOKEN_BUDGET_PER_HOUR`) and **preview limits**
  (`PREVIEW_IDLE_TIMEOUT_MS`, `PREVIEW_MAX_INSTANCES`) are off/generous by
  default.

The embedded proxy has its own notes in `proxy/README.md`.

## DNS

Point `BASE_DOMAIN` **and** `*.BASE_DOMAIN` at the proxy listener. The CMS
itself should only listen on localhost.

## First user / admin

Users are created on first OIDC sign-in (gated by the allowlist). Promote the
first admin directly: `UPDATE "user" SET role='admin' WHERE email='…';`
Afterwards the dashboard manages roles.

## Development site

`REPO_PATH` must point at a repository of its own — the git engine refuses a
path without `.git` (git would otherwise walk up into a parent repo).
`scripts/setup-dev-site.sh [basic-site|blog-site] [dest]` copies an example,
`git init`s it, installs its dependencies, and prints the `.env` values
(default destination: `./local/dev-site`, gitignored).

## Development database

Bring your own PostgreSQL (a system service or a container), or let the repo
run one. `scripts/local-postgres.mjs` keeps a cluster under `var/postgres`,
initialised from `DATABASE_URL` and listening only on the loopback host and
port that URL names:

```bash
nix develop --command pnpm run db:start    # init if absent, start, create the database
nix develop --command pnpm run db:status
nix develop --command pnpm run db:stop
```

`db:start` is idempotent and refuses to adopt a foreign server already on that
port. The normal development start applies pending committed migrations;
`pnpm bench` finds the cluster by itself (it derives libpq settings from
`DATABASE_URL`). The unix socket lives in the data directory, so a bare `psql`
needs the `PGHOST`/`PGPORT` that `db:start` prints.

## Running in development

With the PostgreSQL from `DATABASE_URL` running, use the same command on macOS
and NixOS:

```bash
nix develop --command overmind s
```

The Procfile reconciles changed dependencies, environment contracts, Nix
inputs, and the generated Prisma client; applies pending committed migrations;
then runs the CMS dev server with its embedded proxy at `127.0.0.1:8080`.
Overmind sources `.env` into the process. Running
`./scripts/update-local.sh` after a pull is only an optional prewarm.

The Procfile enables **SKIP_AUTH** (development only): no sign-in, every
request runs as `admin@localhost`, and `user@localhost` / `user2@localhost`
are seeded so you can test multi-user behavior — switch identity with
`POST /api/dev/impersonate {"email":"user@localhost"}` (GET lists them).
Astro dev binds `::1` — the launcher sets `HOST=::1`, so the generated routes
file and the proxy dial the same IPv6 address.

## NixOS note (development)

Prisma CLI needs the nixpkgs engines: `source scripts/prisma-env.sh` (the
flake dev shell does this automatically). Test database preparation refuses to
run without that pinned engine rather than downloading a vendor binary; both
paths also disable Prisma's checkpoint request.
