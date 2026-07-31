# Testbench coverage map

Production-path catalog → scenario. `pnpm bench` runs everything against the
locally booted production build (see `launcher.mjs`). Status legend:
✅ covered · 🟡 partially (see note) · ⛔ n/a under the bench setup (reason).

## API surface

| Path | Scenario | Status |
|---|---|---|
| `GET /api/version` | 01 | ✅ |
| `GET/PATCH /api/me` | 01, 02 (theme/language persist) | ✅ |
| `GET/POST /api/dev/impersonate` (+400) | 01 | ✅ |
| `POST /api/chats` (+400 no branch, warm-branch adoption) | 01, 03 | ✅ |
| `POST /api/chats/[id]/approve-plan` (+guards) | guards in 01 | 🟡 only reachable in explicit plan mode (`/plan`) since plans are otherwise recorded, not submitted — 03's journeys need reworking for it |
| `POST /api/chats/[id]/request-changes` | 03 (journey B) | ✅ |
| `POST /api/chats/[id]/finalize` | 03 | ✅ |
| `POST /api/chats/[id]/publish` (+repeat guard) | 03 | ✅ |
| Deploy pre-validation (merged tree built with the site backend before anything moves) | 03 — the git-push publish runs `astro build` on the merged tree first | 🟡 the passing path only; rejection is unit-covered (test/deploy-prevalidation.test.ts) and the jailed build failure in test/integration/deploy-flows.test.ts, because bench-driving it needs the agent to commit a change that breaks the build |
| `POST /api/chats/[id]/sync` (pull automatism) | 03 (journey B) | ✅ |
| Automatisms refused while a turn is live (sync + publish → 409) | — | 🟡 unit-covered (test/automatism-turn-guard.test.ts); bench-driving needs a request timed against a running agent turn |
| `POST /api/chats/[id]/resume-automatism` | 06 (pull-conflict + deploy-failure pauses; user-resume or self-resume + 404 guard) | ✅ |
| `GET /api/chats/archived` | 01, 03 (archive-on-done) | ✅ |
| `DELETE /api/chats/archived` | 05 (final destructive probe) | ✅ |
| `GET /api/chat/events` (SSE event stream) | 01/03 (collector), 02 (live UI) | ✅ |
| `GET /api/chat/history` | 01, 03 (state polling) | ✅ |
| `POST /api/chat/message` (202, turn-lock 409, answer routing) | 03 | ✅ |
| `POST /api/chat/context` | 01 | ✅ |
| `POST /api/chat/stop` (interrupt a running turn; 409 with none running) | 03 | ✅ |
| `GET/PUT /api/chat/tabs` | 01 (API), 02 (UI) | ✅ |
| `POST /api/chat/element-handoff` | 03 | ✅ |
| `GET/POST /api/branches` (+name validation) | 01 | ✅ |
| `GET /api/branches/[id]/history` | 03 | ✅ |
| `POST /api/branches/[id]/restore` | 03 (roundtrip) | ✅ |
| `POST /api/branches/[id]/revert` | 03 (guards), 06 (positive revert on its own journey) | ✅ |
| `GET /api/git/commits` / `GET /api/git/commit` | 02 (UI), 03 (API) | ✅ |
| `GET /api/diff/[chatId]/pages` | 03 | ✅ |
| `GET /api/diff/[chatId]/shot` (after/diff/meta) | 03 | 🟡 kinds before/aligned/markers not probed |
| `GET /api/preview/browsers-shot` (incl. `device=` emulation + unknown-device 400) | 05 | ✅ |
| `GET /api/files/[chatId]` (dir/file/jail) | 01 | 🟡 mode=download/raw not probed |
| `POST/GET /api/uploads` (+400, CSRF pass behind TLS termination via forwarded headers) | 01 | ✅ |
| `GET/PUT/DELETE /api/window-sessions[/id]` (+ownership) | 01 (API), 02 (restore UX) | ✅ |
| `GET /api/agent/capabilities` (incl. per-skill scripts + origin) | 01 | ✅ |
| Deployment chats refuse site writes unless their deploy is paused (files, images, run_command; `.scratch/` exempt) | — | 🟡 unit-covered (test/deploy-chat-writes.test.ts); bench-driving needs an agent turn in a deployment chat asking for a page change |
| Skill scripts (declared/derived/overlay resolution, jail limits) | — | 🟡 unit-covered (test/skill-scripts.test.ts) + real-jail limits in test/integration/skill-scripts.test.ts; bench-driving needs a bench-installed skill that ships one |
| `GET/POST /api/memory` | 01 | 🟡 approve/reject of a real candidate needs the agent to propose one |
| `GET /api/publications` (list + detail) | 01, 03 | ✅ |
| `/api/admin/*` (all routes, editor 403) | 01 (403), 04 (admin) | ✅ |
| `/api/admin/grants` | 04 (asserts it 404s) | ⛔ removed with autonomy grants |
| `GET /dashboard` (admin gate) | 04 | ✅ |
| `/injected-cms-agent.js`, `/injected-agent-module.js`, `/injected-annotate.js` | 01 | ✅ — also the regression guard for the proxy front door vs. prerendering: these three are prerendered, so a guard that does not step aside at build time ships its own 403 note as the bundle, and only a probe against a real production build sees it |
| `/__preview/boot/<branch>` (CMS-host redirect) | 05 | ✅ |
| `/__preview/wait/<branch>` (SSE) | 05 | ✅ |
| `<branch>.BASE_DOMAIN` proxy routing + injection | 05 | ✅ |
| OAuth signin flow (full authorization-code + PKCE round trip) | 07 (instrumented mock IdP, own server boot without SKIP_AUTH) | ✅ |
| Email allowlist (ALLOWED_EMAILS admit, domain-rule admit, reject) | 07 | ✅ |
| Unauthenticated 401s / signin redirect / public paths / impersonate-off | 07 | ✅ |
| Deep-link ?next= carry-through signin (validated same-origin path) | 07 | ✅ |
| Session cookie migration to Domain=.BASE_DOMAIN | — | ⛔ migration is a no-op when BASE_DOMAIN=localhost (the bench's only hermetic domain) |

## UI flows (Playwright)

| Flow | Scenario | Status |
|---|---|---|
| Workspace boot, window-picker offer, silent restore | 02 | ✅ |
| Chat composer + example prompts | 02 | ✅ |
| New branch-panel chat | 02 | ✅ |
| One-click new chat from the switcher header | 02 | ✅ |
| Theme toggle (persisted) | 02 | ✅ |
| Preview page follows the workspace theme (live flip) | 02 | ✅ |
| Diff viewer: pane browsing syncs other pane + route chip, address free-browse | 05 | ✅ |
| Route-chip dropdown (changed pages list, pick navigates + closes) | 05 | ✅ |
| Icon rail (stage tools + registered windows + settings) + compact header (branch pill, version chip, avatar icon) | 02 | ✅ |
| Composer element-picker button (arms/disarms) | 02 | ✅ |
| Publish / request-changes action row under the composer (preview phase) | 05 | ✅ |
| Stop button while the agent works (composer card → turn ends, transcript note) | — | 🟡 the endpoint and loop behaviour are covered in 03 + test/turn-stop.test.ts; the button itself is not clicked in a browser |
| Chat transcript scroll preserved across rerenders (tool-use jump fix) | 05 | ✅ |
| Element picker from the icon rail in the compare window (arm → live preview on diff route → cancel returns to compare) | 05 | ✅ |
| Edit mode from the icon rail; hover flyout offers tools/undo/clear/exit while handoff stays visible; comment target highlights blue; comments have a paper-plane submit button and can be edited; exit returns to diff viewer | 05 | ✅ |
| Chat visibility setting (restricted hides foreign chats, admin bypass) | 07 | ✅ |
| Picker/edit hint banner closeable, dismissal persists | 02 | ✅ |
| Language switch en↔de (judged screenshot) | 02 | ✅ |
| Commits / capabilities (including dynamic `via <name> plugin` origins beside skill titles) / archive / sessions windows | 02 | ✅ |
| Workspace URL routing (/chat/<id>?window=…: mirror, browser back, deep-link boot) | 02 | ✅ |
| Preview device presets (viewport-sized iframe + proxy UA override + navigator patch) | 02 | ✅ |
| Compare window: eye button opens/closes it, flyout lists the four views, outside click closes the list only | 02 | ✅ |
| Draft chats: preview tools enabled before materialization; new-chat/one-click create no Chat row; opening an existing chat leaves the draft | 02 | ✅ |
| Task list in the chat snapshot (agent notes stay server-side) | 01 | ✅ |
| Orphan sweeper (hourly: worktrees + sandbox homes of deleted chats, keeps pooled/serving branches, never deletes a foreign git ref) | — | 🟡 unit-covered (test/worktree-cleanup.test.ts); bench-driving needs an hour of wall clock or an admin trigger |
| Warm previews (pinned primary branches + adopted spare work branch) | 02 | 🟡 02 waits on `/api/admin/previews` reporting the chat's branch ready, which only passes when warming works; pinning/eviction rules are unit-covered (test/draft-chat.test.ts) |
| Code browser (tree, open file — judged) | 02 | ✅ |
| Code browser image preview (svg renders inline, naturalWidth > 0) | 02 | ✅ |
| Preview tabs new/switch/close | 02 | ✅ |
| Shared navigation bar (route input + reload) in preview and compare | 02 (preview reload), 05 (compare address + reload) | ✅ |
| Sidebar collapse/resize | 02 | 🟡 collapse only; drag-resize not simulated |
| Plan/execution/publish cards | — | 🟡 exercised via API in 03; card DOM not driven (approve via endpoint, not button) |
| Element-edit overlay (draw/move/comment in-iframe) | — | 🟡 handoff covered API-side in 03; in-iframe drawing not driven |
| Browser compare UI, diff-viewer modes UI | — | 🟡 endpoints covered (03/05); overlay UIs not driven |
| Attachments upload + send with image; upload from a draft materializes the chat | 01 (API), 02 (draft composer) | ✅ |
| Composer paste (image ctrl+v/context menu), long-text-as-attachment, dropzone drop | 02 | ✅ |
| Upload-failed chip shows the server reason (incl. non-JSON bodies) | — | 🟡 unit-covered (test/attachment-upload-errors.test.ts); bench-driving needs a deterministically failing upload |
| Hex → color-name chips in chat markdown | — | 🟡 covered by unit tests through renderMarkdown (agent must mention a hex to drive it in bench) |
| Collapsed tool-call groups (grouping, running state, meta preview, mode gate) | — | 🟡 unit-covered (test/tool-groups.test.ts); bench-driving needs a technical-mode agent turn in a browser session |
| Routeless-files warn chip + toggle banner (diff viewer) | — | 🟡 unit-covered (test/diff-renderer.test.ts); bench-driving needs a journey that changes non-page files |
| Rail tooltips paint over the expanded compare flyout (and the flyout's own button shows one label) | — | 🟡 unit-covered by pixel probe (test/rail-tooltip-realbrowser.test.ts); the bench asserts DOM, not paint order |
| `/plan` command: chip in the transcript, explicit plan mode, propose_plan replaces start_execution | — | 🟡 unit-covered (test/commands.test.ts) + the autocomplete driven with real keystrokes (test/command-autocomplete-realbrowser.test.ts); bench-driving needs a live agent turn under the mode |
| `/architecture` reference page (public, mermaid diagrams) | 07 (reachable without a session) | 🟡 07 checks the route is public and ships diagram markup; that every diagram *renders* is unit-covered (test/architecture-page.test.ts) |
| Workflow-phase run boundary (start_execution / return_to_plan end the run; the next one gets the new phase's prompt + tools) | — | 🟡 unit-covered (test/phase-run-boundary.test.ts); bench-driving needs a live agent to pick start_execution over propose_plan, which is its judgement call |
| External MCP phase gate (custom/repo servers full only in EXECUTE, declared read-only tools while planning; deployment monitor always reduced) | — | 🟡 unit-covered (test/mcp-policy.test.ts); readOnlyHint surviving the jailed bridge is covered in test/integration/custom-mcp.test.ts; bench-driving needs a configured custom MCP server in the bench environment |

| Capability router (SKILL_ROUTER_MODEL picks the skills/MCP groups the prompt carries; a failure fails the turn, never falls back to the full list) | — | 🟡 unit-covered (test/skill-router.test.ts, test/capability-tools.test.ts); every bench turn exercises it implicitly — a broken router fails 01/03 outright, which is the intended visibility |
| Lazy MCP loading (defaults only at turn start; load_mcp/unload_mcp per group; an unloaded group's server never starts; phase policy still narrows a freshly loaded group) | — | 🟡 unit-covered (test/mcp-lazy-load.test.ts, test/mcp-groups.test.ts); bench-driving needs a configured custom MCP server in the bench environment, same blocker as the phase gate above |

| Post-sync site check (backend error detection → automatism pause → agent fix → re-check on resume) + restart_preview | — | 🟡 unit-covered (test/site-health.test.ts drives a real HTTP dev-server stub, test/site-check-automatism.test.ts drives the flow against the DB); bench-driving it needs a sync that deliberately breaks the draft, which 06 does not do |

| Compare shot staleness (generation bumped by the turn loop, in the cache key and the shot URL, `compare_stale` reload) | — | 🟡 unit-covered (test/compare-staleness.test.ts) |
| Automatism repair turn (waits out a running turn, folds duplicate failures, reports when it cannot start, re-invokes abandoned repairs on boot) | 06 (real conflict → repair turn) | 🟡 partly: 06 drives the happy path; the busy/dedupe/give-up paths are unit-covered (test/automatism-repair-turn.test.ts) |

## Agent tool paths (implicit via e2e prompts)

Every e2e agent turn sends `reasoning_effort` (OPENAI_REASONING_EFFORT,
default medium; `none` omits) — env default unit-tested in
test/model-effort.test.ts.

Read tools + write_file/edit_file + git commit (03 journey), propose_plan /
ask_question / finish_execution client tools (03; pick_color registered +
UI unit-tested — bench-driving it needs a prompt that makes the agent call it),
start_execution / open_compare / add_tasks / update_task (unit-tested in
test/shadow-plan.test.ts + test/task-tools.test.ts — which of them a live
agent picks is its judgement call, so the bench cannot demand any one of
them), conflict tools +
resume_automatism (06 pull-conflict resolution turn), screenshot/diff
pipeline (03/05). Web tools, generate_image, run_command, use_skill,
propose_memory: ⛔ not deterministically triggerable — would need
prompt-engineering the agent into specific tools; revisit with dedicated
prompts if coverage is wanted.
