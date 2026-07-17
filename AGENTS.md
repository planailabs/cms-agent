# cms-agent — agent notes

Chat-agent CMS for Astro sites. Full docs in `docs/` (architecture, phases,
setup, runbooks); start with `docs/architecture.md`.

## Ground rules

- `chat/` is the **read-only reference app** the UI/loop was extracted from —
  never modify it; it is not part of this build.
- TypeScript strict everywhere; vanilla-TS UI with a pub/sub store
  (`src/components/chat/app/store.ts`) — no UI frameworks.
- DB changes ONLY via Prisma migrations (`npx prisma migrate dev`); the
  schema must stay provider-portable (no enums, no pg-native types) because
  tests run it on SQLite (`scripts/prepare-test-db.mjs`).
- On NixOS the Prisma CLI needs engine env vars:
  `source scripts/prisma-env.sh` (or `nix develop`).
- Workflow-phase transitions are POST endpoints, never chat text; tool
  availability is enforced in `src/lib/agent/tools/registry.ts` — keep it
  that way when adding tools (zod schema + `phases` + registered in
  `src/lib/agent/handler.ts`).
- New deploy targets: implement `DeployFlow` in `src/lib/publish/` and
  register it — don't special-case the publisher.
- New site-type behaviors: implement `ContentAdapter` in `src/lib/content/`.

## Sandbox (all site shell calls)

Every command run against the managed site — `npm install`, the preview dev
server (`npx astro dev`), publish builds, and the `run_command` tool — runs
inside a bubblewrap jail (`src/lib/sandbox/`), never raw `child_process`.

- The jail is deny-by-default: only the per-major node env's `/nix/store`
  (overshadowing the app's store), the chat's worktree (`/work`), a
  per-session HOME, tmpfs/proc/dev, and a minimal `/etc` (DNS) are bound in.
  Use `spawnSandboxed` (long-lived) / `runSandboxed` (one-shot); don't spawn
  site processes directly.
- The env is a nix-built squashfs holding all node majors (22/24/26) as
  self-contained per-major stores (`node + coreutils/bash/cacert/gawk/gnugrep/
  ripgrep/python3`), deduped by mksquashfs. Select with `SANDBOX_NODE_MAJOR`;
  `SANDBOX_ALLOW_NETWORK` toggles jail network (default on, needed for
  `npm install`). Built on the fly in dev/test by
  `scripts/launch-with-sandbox.sh` (the Procfile + test scripts run through it).
- The container MUST run with `security_opt: [seccomp=deploy/seccomp/cms-agent.json,
  systempaths=unconfined]` (targeted profile lets bwrap make user+mount
  namespaces; systempaths lets it mount a fresh /proc). See
  `deploy/docker-compose.yml`.

## Git commits

Every commit-creating op (`commitExecution`, `mergeInto`, `revertCommit`,
`restoreVersion`) REQUIRES a `GitIdentity` — the container has no git config,
so an unset identity fails with "Committer identity unknown". Resolve it with
`chatGitIdentity(chatId, actingUserId)` (chat creator → acting user → CMS
default); never call these ops without threading an identity through.

## Previews & diff screenshots

- Preview dev servers bind `HOST` (`::1` in dev, `127.0.0.1` in prod) and the
  routes file / screenshot code must dial the same — never hardcode a host.
- Diff/browser screenshots use the playwright browsers bundled in the image
  (`PLAYWRIGHT_BROWSERS_PATH`, `FONTCONFIG_FILE`); chromium launches with
  `chromiumSandbox:false`. WebKit needs coreutils (`uname`) on PATH.

## Verify

```bash
pnpm test                                 # unit — must stay dependency-free
pnpm test:integration                     # real dev servers + deploy flows
cargo test --manifest-path proxy/Cargo.toml
npx tsc --noEmit && npx astro build
```

UI changes: verify in a real browser against the prod build — see
[`.agents/skills/ui-verify/SKILL.md`](.agents/skills/ui-verify/SKILL.md).
