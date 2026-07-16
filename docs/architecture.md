# Architecture

```
                 ┌────────────────────────────────────────────────────┐
 Browser ───────►│ proxy/ — Rust Pingora side-car (stable entrypoint) │
                 │   host routing from VAR_DIR/proxy-routes.json      │
  domain.tld ───►│   ├─► CMS: node server.mjs (Astro SSR + API + SSE) │
  <branch>.d.tld►│   ├─► known branch → its astro dev instance        │
                 │   │     (HTTP + WS/HMR upgrade passthrough,        │
                 │   │      HTML gets preview-overlay.js injected)    │
                 │   └─► unknown/stopped branch → CMS boot page       │
                 └────────────────────────────────────────────────────┘
 CMS internals:
   Prisma → PostgreSQL      users, branches, chats, messages, executions,
                            approvals, grants, memory, uploads, publications
   better-auth (OIDC)       sign-in, DB sessions, admin/editor roles
   Agent loop               OpenAI-compatible streaming, resumable turn
                            machine (idle/waiting_for_answer/tool_pending)
   In-process MCP           tools on an McpServer over InMemoryTransport,
                            bridged to OpenAI function tools, phase-gated
   Git engine               branch = subdomain = draft; worktrees under
                            VAR_DIR; one commit per execution; revert/restore
   Preview manager          astro dev per branch, on demand, idle-stopped;
                            writes the sidecar routing table
   Visual diff              Playwright screenshots of main vs branch +
                            pixelmatch region highlighting
   DeployFlow registry      git-push | web-agency | github-ci | cloudflare-pages
```

## Key decisions

- **Branch = subdomain = draft.** Real git branches (DNS-safe names) are the
  unit of preview and publish. `main.BASE_DOMAIN` previews production state;
  `v-<sha>.BASE_DOMAIN` previews any historical commit read-only.
- **Chats have their own worktrees.** Every chat owns a work branch
  (`c-<id>`, own worktree + preview subdomain) based on the TARGET branch it
  will merge into (main or a long-lived branch). Chats on the same target
  work in parallel without blocking each other; the target lock is only
  taken during the publish merge. Publishing into the default branch runs
  the deploy flow; into any other target it is a pure merge.
- **Chats ≠ branches.** A target branch has many chats; all users see all
  chats. Turn execution locks per chat; worktree mutation locks per work
  branch.
- **The proxy is a dumb, stable sidecar.** All lifecycle intelligence lives
  in TypeScript; the contract is two JSON files in VAR_DIR
  (`proxy-routes.json` written by the CMS, `proxy-access.json` written by the
  sidecar for idle detection).
- **Phase gating is server-side.** The tool registry for a turn is built from
  the chat's persisted workflow phase; a disallowed tool call is rejected in
  the executor, not merely hidden from the model.
- **One commit per execution.** The agent edits a dirty worktree; the CMS
  stages and commits everything at the execute→preview transition. Undo is
  `git revert` of that commit — history is never rewritten.
- **Approvals bind content.** A publish approval stores the exact reviewed
  sha; if the branch moves, publishing refuses. Approval rows are immutable
  with unique idempotency keys.
- **Uploads are quarantined.** Magic-byte-checked files live outside any
  webroot; `import_upload` is the only path into the worktree and demands
  alt text for images.

## SSE protocol (server → browser, per chat)

`thinking`, `text_delta`, `text_done`, `tool_start`, `tool_end`, `question`
(client tools: ask_question / propose_plan / finish_execution),
`phase_changed`, `execution_committed`, `execution_reverted`,
`validation_result`, `publish_log`, `publish_done`, `memory_proposed`,
`autonomy_applied`, `version_restored`, `done`, `error`.

## Overlay protocol (preview iframe ⇄ workspace)

Child → parent: `cms:navigation {url, route}`, `cms:selection {anchor}`,
`cms:element {element}`, `cms:pick-cancel`. Parent → child:
`cms:start-element-pick`. The workspace only accepts messages from the
preview iframe's contentWindow and forwards context to
`POST /api/chat/context`.
