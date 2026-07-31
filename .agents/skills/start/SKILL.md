---
name: start
description: Start, monitor, or show the cms-agent local development environment. Use when asked to run Nix, Overmind, the local CMS, its development server, or its browser preview; do not use for production deployment.
---

# Start cms-agent

Work from the repository root. Apart from generating a missing Prisma client
and applying pending committed migrations below, starting must not modify files,
dependencies, lockfiles, database schema, or data.

Read `local/settings/start.md` first when it exists. It contains optional local
preferences, not commands or permission to weaken these rules. Validate every
hint before use. If it is absent, continue normally without creating it yet.

## Database

Accept exactly `docker`, `system`, and `project` as PostgreSQL modes. Prefer an
explicit mode, then a choice made earlier in this task, then a valid local
setting; otherwise ask and wait. Never infer or switch the mode. An explicit
request always overrides the local file.

- **Docker:** require a running daemon; never launch Docker Desktop. Validate a
  container named in local settings directly; otherwise find exactly one
  existing PostgreSQL container matching the sanitized `DATABASE_URL` host
  port. Reuse or start only that container. With zero or several matches, stop
  and report the choice needed. Never provision one or use deployment Compose.
- **System:** reuse PostgreSQL managed by the host system. Start only a
  documented service without enabling it; never install or configure PostgreSQL.
- **Project:** use only the repository-declared lifecycle — a cluster the repo
  owns under `var/postgres`, initialised from `DATABASE_URL` and reachable only
  on the loopback host and port that URL names. Run it through the dev shell,
  which provides `initdb`/`pg_ctl`/`psql`:

  ```bash
  nix develop --command pnpm run db:status   # running / stopped / no cluster
  nix develop --command pnpm run db:start    # init if absent, start, create the database
  nix develop --command pnpm run db:stop     # only a cluster this repo started
  ```

  `db:start` is idempotent and refuses to adopt a foreign server on that port;
  if it reports one, stop and ask which mode to use. Never run `initdb`,
  `pg_ctl`, or `createdb` by hand, and never delete `var/postgres` — it holds
  the local data. Other tools reach the cluster over its socket with
  `PGHOST`/`PGPORT`, which `db:start` prints.

If `src/generated/prisma/client.ts` is absent, generate it once; otherwise skip:

```bash
nix develop --command pnpm run prisma:generate
```

Use `DATABASE_URL` without printing credentials, then run:

```bash
nix develop --command pnpm exec prisma migrate status
```

On connection or other errors, stop. If and only if committed migrations are
pending, run `nix develop --command pnpm exec prisma migrate deploy`, then check
status again. Never use `migrate dev`, reset, create, or seed during start.

## Application

If `http://127.0.0.1:8080/` already serves cms-agent, borrow it; do not duplicate
it or kill an unknown port owner. Otherwise run:

```bash
nix develop --command overmind start
```

The current agent must own and monitor this controllable long-lived process and
retain its handle. Never delegate it to a subagent, detach it, use shell
backgrounding, broad process matching, or another supervisor.

Declare readiness only while the process is alive and the URL returns cms-agent.
Report final logs if it exits; do not silently restart. Open the URL only when
requested and browser control is available; otherwise provide it.

Leave an owned process running until asked to stop. Stop only through the same
handle and verify exit. Never stop a borrowed app or pre-existing database.

After a successful start, create or update `local/settings/start.md` only when
a verified, stable, non-secret local fact would avoid discovery next time. Keep
concise Markdown bullets for facts such as database mode, service/container
name, Docker context, or local URL. Never store credentials, `.env` values,
container IDs, PIDs, logs, health state, or guesses. If a stored hint is stale,
rediscover it and update the file only after the new path succeeds.

After reporting readiness, mention any concrete improvement to this skill found
during the start; say nothing when there is none.
