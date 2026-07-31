# cms-agent — agent notes

Chat-agent CMS for Astro sites. The documentation lives in
`src/pages/architecture/` and is served by the app at `/architecture`
(public): the diagram reference is built from `src/components/architecture/`,
the guides are the markdown next to `index.astro`. `docs/` is a symlink to
that directory, so `docs/setup.md`, `docs/phases.md`, `docs/runbooks.md`,
`docs/walkthrough.md` and `docs/nixos.md` still read the same on disk. Start
with `/architecture` (or read the section files directly).

## Optional code knowledge graph

When codebase-memory-mcp tools are available, use them for unfamiliar
architecture, symbol relationships, call or data-flow tracing, and
cross-cutting impact analysis. Skip them for localized edits and exact text,
config, or documentation searches. A user opt-out always wins. If the tools
are unavailable, indexing fails, or graph results are stale or insufficient,
continue with normal search and file reads without treating that as an error.
Never require contributors to install codebase-memory-mcp, and verify affected
files normally before editing.

## First-time local setup

Before the first start, create `.env` and fill in its required values. Without
it the dev server starts but every request fails with an environment-validation
error.

```bash
cp .env.example .env
nix develop --command pnpm prisma:generate
nix develop --command overmind s
```

Use `http://localhost:8080` once Astro reports that it is ready. Port `4321`
is only Astro's internal upstream; developers should access the app through
the embedded proxy on port `8080`.

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
- Need a local PostgreSQL? `pnpm run db:start|db:stop|db:status` runs a
  repo-owned cluster in `var/postgres` from `DATABASE_URL`
  (`scripts/local-postgres.mjs`) — it never touches a server it did not start.
- Workflow-phase transitions are POST endpoints, never chat text; tool
  availability is enforced in `src/lib/agent/tools/registry.ts` — keep it
  that way when adding tools (zod schema + `phases` + registered in
  `src/lib/agent/handler.ts`).
- New deploy targets: implement `DeployFlow` in `src/lib/publish/` and
  register it — don't special-case the publisher.
- New site-type behaviors: implement `ContentAdapter` in `src/lib/content/`.

## Documentation upkeep (do this LAST)

The docs are part of the app, so they go stale the same way code does. Two
things need to stay true:

- **The diagram reference** (`src/components/architecture/*.ts`). Every section
  declares the files it describes in its `source` array. That array is the
  index: `grep -rn "<path you changed>" src/components/architecture/` names
  every section your change can invalidate. If a section's diagram or notes now
  describe something that no longer happens — a transition you added, a guard
  you removed, a step renamed — update it. Renaming or deleting a cited file
  means fixing the `source` entry too; `test/architecture-page.test.ts` fails
  on a path that no longer exists, and feeds every diagram to mermaid so a
  syntax error cannot ship as a red box.
- **The guides** (`src/pages/architecture/*.md`). Change an env var, a phase
  rule, a deploy flow, an operational failure mode, or the NixOS module, and
  the matching guide is wrong until you say so.

The tree also builds on its own — `pnpm build:architecture` emits flat HTML
into `dist-architecture/`, which CI keeps as an artifact beside the container
image. That build uses `astro.config.architecture.mjs` with
`srcDir: site-architecture/`, whose `pages/architecture` is a symlink to the
real pages: Astro finds no middleware there, so nothing of the app (adapter,
Prisma, better-auth, the proxy addon) enters a build that has no database or
environment. Adding a page under `src/pages/architecture/` needs no work here;
adding an import that reaches into app runtime code will break it.

**Timing: this is a single pass at the END of the work, after the code is
finished and the tests pass.** Do not update a diagram in the middle of a
change — the design is still moving, and documenting each intermediate step
means writing it two or three times and reviewing a diff that mixes both. Land
the behaviour first, then do one documentation sweep over everything the change
touched. Nothing here is public-facing prose about *this* deployment: the whole
`/architecture` tree is a public route, so it stays free of runtime state, env
values, hostnames and build identity (the test pins that too).

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

- Skill scripts (`src/lib/agent/skillScripts.ts`, tool in
  `tools/skillScriptTools.ts`) run in the same jail with LESS than
  run_command: the skill's dir read-only at `/skill`, argv (never a shell),
  a read-only `/work` and no network unless the skill's frontmatter declared
  `flags: [write, network]`. The model names a DECLARED script — never a
  path. Scripts only mentioned in a skill's prose are derived and can never
  carry a flag; `${VAR_DIR}/skill-scripts.json` (admin-global, keyed
  `plugin/skill`) is the only way a vendored skill gains one.
- SKILL.md frontmatter is real YAML (`yaml`), with a lenient line-based
  fallback for third-party skills whose headers are not valid YAML (an
  unquoted `description:` containing a colon is common). Structured values
  like `scripts:` are NOT recovered by the fallback.
- Capabilities are demand-driven, and both halves are load-bearing:
  * The prompt lists the skills the router picked, not the install
    (`src/lib/agent/skillRouter.ts`, `SKILL_ROUTER_MODEL`); `query_skills`
    searches the rest. The router has NO fallback — a failed or unparseable
    routing answer fails the turn on purpose, because "list everything
    again" is invisible from the outside and restores the whole cost.
  * MCP tools arrive per GROUP (`src/lib/agent/mcp/groups.ts`): a server is
    always its own group, and servers join a shared set with `"groups": []`
    in `mcp.json` / `.mcp.json` (extra keys mcporter ignores). Only
    `DEFAULT_GROUPS` attaches by itself; `load_mcp` does the rest, and a
    group nobody loaded never starts its server. Loads persist on
    `Chat.loadedMcpGroups`. `toolLoop` rebuilds the tool list every round —
    that is how a mid-run load reaches the model.
  * The group gate is not the phase gate: `mcp/policy.ts` still narrows a
    freshly loaded group to declared-read-only tools outside EXECUTE.
- Site health is a backend capability, not an Astro special case
  (`SiteBackend.detectSiteErrors`, `src/lib/site/health.ts`): "broken" means
  a 5xx from the dev server for Astro and nothing at all for a static site,
  so the adapter answers it. `checkSiteHealth` adds the half no backend can
  see — a dev server that never starts — and returns `ValidationIssue[]`,
  the same vocabulary the pre-commit/pre-publish validators use.
  The `check` step (`publisher.ts`) runs it after a sync and standalone via
  `startSiteCheck`; a broken site pauses the automatism exactly like a merge
  conflict — chat forced to EXECUTE, error posted, agent invoked, and
  `resume_automatism` RE-RUNS the check rather than trusting the fix. Add new
  checkpoints by reusing that step, not by writing another detector.

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
  `request-changes`, `finalize`), never chat text — the exceptions are the
  agent's own `start_execution` (shadow plan) and `return_to_plan`. The message API
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

Dependency changes (`package.json` dependency fields or `pnpm-lock.yaml`) must
also refresh `pnpmDeps.hash` in `package.nix`: set it to `""`, run
`nix build .#default`, then replace it with the reported `got: sha256-...`
value and rerun the build. Do not commit a dependency change until that build
passes.

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
