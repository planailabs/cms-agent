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
- "Read-only" tools are not exempt: linters/formatters/`astro check` execute
  repo config files (`eslint.config.js`, `astro.config.mjs`) as code. A host
  spawn with inherited `process.env` in the agent-writable worktree is RCE +
  secret exfiltration (the lint tools had exactly this). Never spread
  `process.env` into a child that runs site code.
- Custom MCP servers (`src/lib/agent/mcp/custom.ts`) load from
  `${VAR_DIR}/mcp.json` (admin-global) and the branch's `.mcp.json` (repo,
  per-worktree). The whole mcporter runtime runs INSIDE the jail via the
  bundled bridge (`bridgeEntry.ts`, embedded as `virtual:mcp-bridge`) —
  repo-defined stdio servers are acceptable ONLY because of that: they get
  exactly the privileges run_command already has in the jail (worktree at
  /work, clean env, sandbox toolset). Never run an MCP server (or any
  repo-configured command) outside the jail. Web servers need
  `SANDBOX_ALLOW_NETWORK`; global config wins tool-name collisions. Keep
  the definition loader filtered to `source.kind === 'local'` (mcporter
  otherwise layers in servers imported from `~/.claude.json` etc.).

## Client state: rehydrate + sync (pitfalls)

The server is the source of truth; SSE events only mutate LIVE state. Any
UI state that outlives a page reload or chat switch MUST be persisted
server-side and rebuilt from `GET /api/chat/history` in `applyHistory`
(`session.ts`) — the single sync point. Rehydrated today: messages, phase +
`pendingQuestion` (plan/finish/question cards), executions, latest
publication (publish card), automatism progress, `targetAhead`, title,
archived. Pitfalls that actually bit:

- A card rendered only from an SSE event vanishes on reload. Persist the
  fact (chat row / own table), return it from history, restore it in
  `applyHistory` — never carry state over client-side from another view.
- History rehydration must not clobber fresher live state: SSE events that
  landed while the fetch was in flight win (`if (!ws.publish)` etc.).
- `resetWorkspaceChatState` clears chat-scoped workspace state on switch;
  anything it clears must come back via history, or it's lost.
- Workflow decisions are POST transitions (`approve-plan`,
  `request-changes`, `to-preview`), never chat text. The message API
  converts a typed answer to a pending `propose_plan` into a
  `requestChanges` — don't add paths that resolve workflow client tools
  as plain answers.
- Sandbox env binaries are absolute `/nix/store` symlinks that only resolve
  inside the jail — host-side checks must `lstat` the link, not follow it.
- SSE reconnects lose everything broadcast in the gap (the server replays
  only the pending question). After a reconnect, `resyncChatHistory` refetches
  history and applies it SERVER-WINS; the initial restore stays live-wins.
  Keep both modes in `applyHistoryResult` when adding rehydrated state.
- Async UI loads (modals, tab saves, history fetches) must be guarded
  against chat/selection switches mid-flight: seq token or captured-id
  check before applying the response (`loadDiffPages`' `forChatId` is the
  pattern).
- The turn lock is per-chat and in-process. Anything that resumes a turn
  (`resumeTurn` via `approvePlan`/`requestChanges`) silently no-ops while
  the lock is held — never call transitions from code that still holds the
  chat's turn lock (the autonomy auto-approve deadlocked this way).

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
