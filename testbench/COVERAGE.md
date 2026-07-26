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
| `POST /api/chats` (+400 no branch) | 01, 03 | ✅ |
| `POST /api/chats/[id]/approve-plan` (+guards) | 03; guards in 01 | ✅ |
| `POST /api/chats/[id]/request-changes` | 03 (journey B) | ✅ |
| `POST /api/chats/[id]/to-preview` | 03 | ✅ |
| `POST /api/chats/[id]/publish` (+repeat guard) | 03 | ✅ |
| `POST /api/chats/[id]/sync` (pull automatism) | 03 (journey B) | ✅ |
| `POST /api/chats/[id]/resume-automatism` | 06 (pull-conflict + deploy-failure pauses; user-resume or self-resume + 404 guard) | ✅ |
| `GET /api/chats/archived` | 01, 03 (archive-on-done) | ✅ |
| `DELETE /api/chats/archived` | 05 (final destructive probe) | ✅ |
| `GET /api/chat/events` (SSE event stream) | 01/03 (collector), 02 (live UI) | ✅ |
| `GET /api/chat/history` | 01, 03 (state polling) | ✅ |
| `POST /api/chat/message` (202, turn-lock 409, answer routing) | 03 | ✅ |
| `POST /api/chat/context` | 01 | ✅ |
| `GET/PUT /api/chat/tabs` | 01 (API), 02 (UI) | ✅ |
| `POST /api/chat/element-handoff` | 03 | ✅ |
| `GET/POST /api/branches` (+name validation) | 01 | ✅ |
| `GET /api/branches/[id]/history` | 03 | ✅ |
| `POST /api/branches/[id]/restore` | 03 (roundtrip) | ✅ |
| `POST /api/branches/[id]/revert` | 03 (guards), 06 (positive revert on its own journey) | ✅ |
| `GET /api/git/commits` / `GET /api/git/commit` | 02 (UI), 03 (API) | ✅ |
| `GET /api/diff/[chatId]/pages` | 03 | ✅ |
| `GET /api/diff/[chatId]/shot` (after/diff/meta) | 03 | 🟡 kinds before/aligned/markers not probed |
| `GET /api/preview/browsers-shot` | 05 | ✅ |
| `GET /api/files/[chatId]` (dir/file/jail) | 01 | 🟡 mode=download/raw not probed |
| `POST/GET /api/uploads` (+400) | 01 | ✅ |
| `GET/PUT/DELETE /api/window-sessions[/id]` (+ownership) | 01 (API), 02 (restore UX) | ✅ |
| `GET /api/agent/capabilities` | 01 | ✅ |
| `GET/POST /api/memory` | 01 | 🟡 approve/reject of a real candidate needs the agent to propose one |
| `GET /api/publications` (list + detail) | 01, 03 | ✅ |
| `/api/admin/*` (all routes, editor 403) | 01 (403), 04 (admin) | ✅ |
| `GET /dashboard` (admin gate) | 04 | ✅ |
| `/injected-cms-agent.js`, `/injected-agent-module.js`, `/injected-annotate.js` | 01 | ✅ |
| `/__preview/boot/<branch>` (CMS-host redirect) | 05 | ✅ |
| `/__preview/wait/<branch>` (SSE) | 05 | ✅ |
| `<branch>.BASE_DOMAIN` proxy routing + injection | 05 | ✅ |
| OAuth signin flow, allowlist, cookie migration, 401s | — | ⛔ SKIP_AUTH replaces the auth stack; needs an OIDC test IdP |

## UI flows (Playwright)

| Flow | Scenario | Status |
|---|---|---|
| Workspace boot, window-picker offer, silent restore | 02 | ✅ |
| Chat composer + example prompts | 02 | ✅ |
| New branch-panel chat | 02 | ✅ |
| Theme toggle (persisted) | 02 | ✅ |
| Language switch en↔de (judged screenshot) | 02 | ✅ |
| Git modal / capabilities / archive / window sessions | 02 | ✅ |
| Code browser (tree, open file — judged) | 02 | ✅ |
| Preview tabs new/switch/close | 02 | ✅ |
| Sidebar collapse/resize | 02 | 🟡 collapse only; drag-resize not simulated |
| Plan/execution/publish cards | — | 🟡 exercised via API in 03; card DOM not driven (approve via endpoint, not button) |
| Element-edit overlay (draw/move/comment in-iframe) | — | 🟡 handoff covered API-side in 03; in-iframe drawing not driven |
| Browser compare UI, diff-viewer modes UI | — | 🟡 endpoints covered (03/05); overlay UIs not driven |
| Attachments upload + send with image | 01 (API upload) | 🟡 composer chip flow not driven |

## Agent tool paths (implicit via e2e prompts)

Read tools + write_file/edit_file + git commit (03 journey), propose_plan /
ask_question / finish_execution client tools (03), conflict tools +
resume_automatism (06 pull-conflict resolution turn), screenshot/diff
pipeline (03/05). Web tools, generate_image, run_command, use_skill,
propose_memory: ⛔ not deterministically triggerable — would need
prompt-engineering the agent into specific tools; revisit with dedicated
prompts if coverage is wanted.
