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
- **Metrics** (`METRICS_*`) are on by default and need nothing configured in
  development; production refuses to start without `METRICS_TOKEN` (see
  [Metrics](#metrics)).
- **Notifications** (`NOTIFY_*`) are entirely opt-in: a channel with no
  provider configured is never offered to anyone (see
  [Notifications](#notifications)).

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

## Metrics

Prometheus exposition at **`/metrics` on the CMS host**, through the proxy
like every other route — nothing extra to publish or firewall.

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://cms.example.com/metrics
```

It is served by a small listener the CMS starts on an **ephemeral loopback
port**, published to the proxy in the routes file (`VAR_DIR/proxy-routes.json`,
key `metrics`) exactly like a preview upstream. Until it is listening the key
is absent and the proxy answers `/metrics` with a 404. One scrape covers the
whole process: the CMS's OpenTelemetry instruments and the embedded proxy's own
registry are concatenated into a single exposition.

`METRICS_TOKEN` is **required in any production build** — the built server
refuses to boot without it, because there the endpoint is reachable wherever
the CMS is. That covers both deployments: the docker image (which also sets
`NODE_ENV=production`) and the NixOS module (which does not). Set one, or set
`METRICS_ENABLED=false`. `astro dev` and the test suite need neither.

For the NixOS module it belongs in `services.cms-agent.environmentFile`
alongside the other secrets; for the compose stack, in the `environment:`
block of the CMS service.

What is measured, and where it is recorded:

| Metric | Type | Labels | Source |
|---|---|---|---|
| `cms_turn_duration_seconds` | histogram | `outcome` = ok/error/stopped | one agent turn end to end (`lib/agent/handler`) |
| `cms_tokens_total` | counter | `model`, `kind` = input/output | every model response, including the skill router and compaction |
| `cms_toolcall_duration_seconds` | histogram | `tool`, `outcome` | every agent tool call, built-in and MCP (`lib/agent/mcp`) |
| `cms_preview_start_duration_seconds` | histogram | `phase` = deps/server, `outcome` | the two halves of booting a branch preview |
| `cms_preview_instances` / `cms_preview_starting` / `cms_preview_capacity` | gauge | — | running dev servers against `PREVIEW_MAX_INSTANCES` |
| `cms_install_queue_depth` | gauge | — | site dependency installs queued behind the serialized installer |
| `cms_deploy_duration_seconds` | histogram | `flow`, `outcome` | a publication, from the row being created to succeeded/failed |
| `cms_screenshot_duration_seconds` | histogram | `kind`, `outcome` | Playwright captures (compare shots, handoff, aligned) |
| `cms_sse_streams` / `cms_turns_active` | gauge | — | open chat SSE connections; chats with a turn in flight |
| `cms_http_server_duration_seconds` | histogram | `route`, `status` | every request, labelled by route pattern |
| `cms_proxy_requests_total` | counter | `decision`, `status` class | the proxy: `cms`/`preview`/`boot`/`metrics`/`unauthorized`/`notfound` |
| `cms_proxy_request_duration_seconds` | histogram | `decision` | proxy request lifetime |
| `cms_proxy_upstream_errors_total` | counter | `decision` | proxy or upstream failures |

Labels are deliberately bounded: no branch names, no chat ids, no raw paths.
A route miss is `cms_proxy_requests_total{decision="notfound"}`; per-preview
attribution comes from the CMS-side preview metrics instead.

### OpenTelemetry auto-instrumentation

Separate from the exposition above, which is *scraped* from the process:
`@opentelemetry/auto-instrumentations-node` *pushes* traces and metrics for
http, pg/prisma, dns and the rest to a collector. Every launch path already
starts node with the flags that make it possible, because they cannot be added
to a process after it has booted:

```
--disable-warning=DEP0205
--import <repo>/otel-hook.mjs
--import @opentelemetry/auto-instrumentations-node/register
```

`otel-hook.mjs` is a three-line shim that calls `module.register()` on
`@opentelemetry/instrumentation/hook.mjs`. It is a file rather than a flag for
two reasons. `--experimental-loader=…/hook.mjs` does the same job and prints a
warning on every boot saying it may be removed; the replacement node suggests
is a `data:text/javascript,…` URL with quotes and semicolons in it, which then
has to survive `NODE_OPTIONS`, a systemd unit and a docker entrypoint. And the
bare specifier inside the shim resolves against **the shim**, not the working
directory — the service runs from `VAR_DIR` / `/data`, where `@opentelemetry`
is nowhere in reach, so the launcher only needs an absolute path to one file.

One package is excluded from the hook: **openai@4**, whose shim registry keeps
state in `export let` bindings and reads it back through `import * as shims`.
`import-in-the-middle`'s namespace proxy does not carry live bindings, so the
read says "nothing registered" after the write registered it, and openai
throws `you must import 'openai/shims/node' before importing anything else` at
import time — the server never boots. Nothing is lost: there is no openai
instrumentation, and its API calls are still traced as HTTP. `test/
otel-hook.test.ts` pins both directions, so the exclusion goes away by itself
the day this repo moves to openai v5+ (which deleted `_shims`).

`--disable-warning=DEP0205` silences node 26's other complaint: it deprecates
`module.register()` in favour of `registerHooks()`, which takes *synchronous*
hooks — `import-in-the-middle`'s are async, so `register()` remains the only
API that fits. One warning code is suppressed, not the channel. (Needs node
≥ 21.3; both deployments are on 26.)

`scripts/start-local.sh` passes them as **node argv** on the `astro dev`
process, not through `NODE_OPTIONS`. Every node process below the launcher
inherits that variable, and the ESM hook is not harmless in all of them: it
turns pnpm's "is there a `.pnpmfile` here?" probe from *no* into a thrown
`ERR_MODULE_NOT_FOUND`, which killed `pnpm dev` before astro started. In
production the wrapper does set `NODE_OPTIONS`, because there it is set *on
the server binary itself* — and `lib/serverRuntime` deletes it at boot so the
processes the CMS spawns do not inherit it either. The nix wrapper uses
absolute store paths and asserts at build time that all three files exist.

Only the exporter is opt-in. It ships `OTEL_SDK_DISABLED=true`, because the
SDK otherwise pushes to `localhost:4318` and logs every failed export. To turn
it on, set `OTEL_SDK_DISABLED=false` and `OTEL_EXPORTER_OTLP_ENDPOINT`.

**Not in `.env`.** Unlike every other knob in this document, `OTEL_*` has to be
in the *process* environment: the SDK is registered by `--import` before any
application code runs, while `.env` is read from inside the app (`dotenv`, at
import time). Put them in `.overmind.env` in development, the compose
`environment:` block, or `services.cms-agent.extraEnvironment`. Worth setting
alongside them: `OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process,serviceinstance`
— the default list includes cloud detectors that probe a metadata server which
does not answer outside GCP/AWS/Azure, and log a warning per boot.

`NODE_OPTIONS` is dropped from the environment at boot (`lib/serverRuntime`)
so it is not inherited by the processes the CMS spawns — publish scripts,
wrangler, site builds. They run with a different working directory and no
`@opentelemetry` in reach, and would die resolving the loader.

## Notifications

"Tell me when this chat is done" — the bell beside the branch switcher. A turn
can run for many minutes and the person who started it is usually elsewhere by
the time it ends, so they can arm an email and/or an SMS for the next time it
stops. It fires whichever way the turn ended (finished, a question, an error)
and then **switches itself off**: a standing subscription would text somebody
on every turn of a conversation they came back to hours ago, and that mistake
is billed per message.

Arming is per chat and per person. Two channels ship, each with a small
registry of providers — adding one is a `registerNotifyProvider` call in
`src/lib/notify/providers.ts`, the same shape deploy flows and site backends
already use:

| Channel | Providers | Address comes from |
|---|---|---|
| `sms` | `twilio`, `notifme`, `logger` | the number the user saves in the notify modal |
| `email` | `resend`, `notifme`, `logger` | the OIDC identity — never editable here |

Most of the delivery is libraries rather than hand-rolled HTTP. `twilio` is the
official SDK: Twilio has far more surface than a POST — API keys versus
account tokens, regional accounts, Messaging Services, retries, typed error
codes — and every one of those was a live 401 or 404 here before it was a line
of config. `notifme` is `notifme-sdk`, the same idea one level up: one config
shape over a dozen vendors per channel, plus failover between several of them.
`resend` stays hand-written because notifme has no Resend provider and the
whole of it is one authenticated POST. `logger` is the dry run — it delivers
to the server log, so a deployment can prove the wiring before handing
anyone's phone number to a vendor.

Configuration is three variables per channel: which provider, the sender
identity, and that provider's credentials as a JSON object. Vendor-specific
variable names would mean the env schema grows a section per provider anyone
ever adds.

```bash
NOTIFY_SMS_PROVIDER=twilio
NOTIFY_SMS_FROM=+15005550006          # or a Messaging Service SID (MG…)
NOTIFY_SMS_CONFIG='{"accountSid":"AC…","apiKeySid":"SK…","apiKeySecret":"…","region":"ie1"}'

NOTIFY_EMAIL_PROVIDER=resend
NOTIFY_EMAIL_FROM=cms@example.com
NOTIFY_EMAIL_CONFIG='{"apiKey":"re_…"}'
```

Twilio takes either credential — `{"accountSid":"AC…","authToken":"…"}` or,
preferably, the API key pair above, which can be revoked without rotating
everything the account owns. **`accountSid` is required in both**: the SDK
acts *on* an account whoever signs the request. `"region"` is required for an
account homed outside the default one (`ie1`, `au1`, `sg1`, …) — the default
host rejects a regional account's credentials with a plain 401,
indistinguishable from a wrong password.

For `notifme`, the config **is** notifme's own provider descriptor, so its
documentation is the documentation — `{"type":"sendgrid","apiKey":"…"}`,
`{"type":"smtp","host":…}`, `{"type":"nexmo",…}`. Several at once, which is
the reason it is here:

```bash
NOTIFY_EMAIL_CONFIG='{"providers":[{"type":"sendgrid","apiKey":"…"},{"type":"smtp","host":"…"}],
                      "multiProviderStrategy":"fallback"}'
```

Numbers are stored E.164 and rejected at the API if they are not — spaces,
dashes and parentheses are stripped rather than refused.

Unset means off, in both directions: a channel with no provider does not
appear in the modal, and a person with no address for a configured channel
sees it greyed out with the reason. Delivery failures are logged and never
fail the turn they were reporting on.

Unrelated to [Metrics](#metrics) above despite both being "observability":
that endpoint is scraped by machines, this reaches a person.

## NixOS note (development)

Prisma CLI needs the nixpkgs engines: `source scripts/prisma-env.sh` (the
flake dev shell does this automatically). Test database preparation refuses to
run without that pinned engine rather than downloading a vendor binary; both
paths also disable Prisma's checkpoint request.
