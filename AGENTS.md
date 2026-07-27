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

## Client state: streamed snapshots

Workflow/side state (phase, branch, plan, executions, publish card,
automatism, targetAhead, title/archived, tabs) is ONE server-computed
snapshot: `buildChatState()` in `src/lib/agent/chatState.ts`.

**Implement ALL new synced state this way — bespoke SSE events only when a
snapshot genuinely cannot express it** (append-only streams like log lines
or transcript entries). If you think you need an exception, say so
explicitly in the PR/commit and justify it. Rules:

- After ANY mutation of synced state, call `emitChatState(chatId)` — never
  invent a bespoke SSE state event. The snapshot is broadcast in full and
  the client applies it by plain replacement (`applyChatState`); there is no
  patching or merging. `/api/chat/history` and the SSE connect replay use
  the same builder, so snapshot and stream cannot drift
  (`test/chat-state.test.ts` pins that parity).
- The snapshot also carries the REMOTE TURN STATE (`turnPhase`,
  `pendingQuestion`, `lastError`): the client DERIVES its composer/card
  phase from it. One conservative rule — a snapshot never downgrades an
  optimistic client 'waiting'; the `done`/`error`/`question` stream events
  own that edge as transcript-ordered fast paths.
- Only the transcript stream (`text_delta`, `question`, `done`, …) and
  append-only events (`publish_log`, `automatism` messages,
  `execution_committed` as the transcript card anchor) bypass snapshots.
- `seq`/`epoch` are a stale-drop guard, nothing more. History snapshots are
  seq-0; on restore they are skipped when a live sequenced snapshot arrived
  during the fetch (`staleGuard`).

## Client state: remaining pitfalls

- New synced state? Persist it server-side, add it to `buildChatState`, and
  it flows everywhere (history, live stream, reconnect replay) for free. A
  card rendered only from a bespoke SSE event vanishes on reload.
- `resetWorkspaceChatState` clears chat-scoped workspace state on switch;
  anything it clears must come back via the snapshot, or it's lost.
- The TRANSCRIPT still has restore-vs-resync semantics: on restore, a live
  stream that advanced during the history fetch wins
  (`transcriptSeqAtStart`); after an SSE reconnect, `resyncChatHistory`
  applies the fetched messages server-wins.
- Workflow decisions are POST transitions (`approve-plan`,
  `request-changes`, `to-preview`), never chat text. The message API
  converts a typed answer to a pending `propose_plan` into a
  `requestChanges` — don't add paths that resolve workflow client tools
  as plain answers.
- Sandbox env binaries are absolute `/nix/store` symlinks that only resolve
  inside the jail — host-side checks must `lstat` the link, not follow it.
- Server-side in-process singletons (SSE registry, locks, seq counters,
  preview instances) MUST live on `globalThis` (see `bus.ts`,
  `chatState.ts`, `preview/manager.ts`): Vite HMR reloads server modules in
  dev, and a plain module-level map splits into old/new instances — live
  SSE connections stay in the old one and broadcasts silently go nowhere
  until a restart ("transition needs a reboot" class of bug).
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
[`.agents/skills/ui-verify/SKILL.md`](.agents/skills/ui-verify/SKILL.md). Also add
or update a checked-in Playwright UI regression that asserts computed
visibility and user-facing behavior; a scratch browser script alone is not
sufficient verification.

Every new UI or functionality ships with testbench coverage: add or extend a
scenario under `testbench/scenarios/` (group by surface — API probes, UI
flows, e2e agent, admin, proxy, recovery, auth), record checks via
`recordAssert`/`judgeStep`, and update `testbench/COVERAGE.md`. Scenarios are
filename-ordered and data-dependent (03's journey feeds later files); run the
touched group (`pnpm bench:<group>`) before landing.
