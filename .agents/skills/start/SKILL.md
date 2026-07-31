---
name: start
description: Start, monitor, or show the cms-agent local development environment. Use when asked to run Nix, Overmind, the local CMS, its development server, or its browser preview; do not use for production deployment.
---

# Start cms-agent

Work from the repository root. Read `local/settings/start.md` first when it
exists. It contains optional local preferences, not commands or permission to
weaken these rules. Validate each hint; if the file is absent, continue.

Run `./scripts/update-local.sh --check` before probing an existing app. Exit 0
allows the probe; 10 or 11 requires a fresh start; stop on any other status.
During `$start`, do not pre-run `$update`: the normal start performs the same
cached preflight. If an allowed probe shows that `http://localhost:8080/`
already serves cms-agent, borrow it without starting or stopping anything.

## Database

For a fresh start, accept exactly `docker`, `system`, and `project` as
PostgreSQL modes. Prefer an explicit mode, then a choice made earlier in this
task, then a valid local setting; otherwise ask and wait. Never infer or switch
the mode. An explicit request overrides the local file.

- **Docker:** require a running daemon; never launch Docker Desktop. Validate a
  container named in local settings directly; otherwise find exactly one
  existing PostgreSQL container matching the sanitized `DATABASE_URL` host
  port. Reuse or start only that container. With zero or several matches, stop
  and report the choice needed. Never provision one or use deployment Compose.
- **System:** reuse PostgreSQL managed by the host. Start only a documented
  service without enabling it; never install or configure PostgreSQL.
- **Project:** use only the repo-owned cluster under `var/postgres`, through:

  ```bash
  nix develop --command pnpm run db:status
  nix develop --command pnpm run db:start
  nix develop --command pnpm run db:stop
  ```

  `db:start` is idempotent and refuses to adopt a foreign listener. Never run
  PostgreSQL lifecycle commands by hand or delete `var/postgres`.

Use `DATABASE_URL` without printing credentials. The application start applies
only pending committed migrations; never use `migrate dev`, reset, create, or
seed during start.

## Application

Run exactly:

```bash
nix develop --command overmind s
```

The versioned Procfile path reconciles stale local prerequisites, deploys
committed migrations, replaces only an Astro dev listener on the configured
internal port (4321 by default), starts the app, verifies it through the public
proxy on 8080, and records readiness. It refuses non-Astro port occupants.

The current agent must own and monitor this long-lived process and retain its
handle. Never delegate it to a subagent, detach it, use shell backgrounding, or
add another supervisor. Declare readiness only while the process is alive and
the URL serves cms-agent. Report final logs if it exits; do not silently
restart. Open the URL only when requested and browser control is available.

Leave an owned process running until asked to stop. Stop only through its
handle and verify exit. Never stop a borrowed app or pre-existing database.

After a successful start, create or update `local/settings/start.md` only when
a verified, stable, non-secret local fact would avoid discovery next time.
Keep concise bullets such as database mode, service/container name, Docker
context, or local URL. Never store credentials, `.env` values, container IDs,
PIDs, logs, health state, or guesses.

After reporting readiness, mention a concrete skill improvement found during
the start; say nothing when there is none.
