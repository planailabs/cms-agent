# Workflow phases and approvals

Every chat cycles through four phases. Transitions are **HTTP endpoints,
never chat text** — the model cannot advance the workflow by itself.

```
 PLAN ──approve-plan──► EXECUTE ──to-preview──► PREVIEW ──publish──► PUBLISHED
  ▲                        │                      │                     │
  └──── request-changes ◄──┘ (via plan rounds)    └── request-changes ──┘
  ▲                                                                     │
  └───────────── success: branch resets onto new main ──────────────────┘
```

## PLAN (read-only)

The agent analyzes the site (read/search/git tools only — write tools are
rejected server-side) and asks clarifying questions. When ready it calls
`propose_plan` once: summary, ordered steps, file list with actions, affected
pages, risk class (`content < template < code < dependency`), open questions.
The turn pauses; the browser renders an approval card.

- **Approve** (`POST /api/chats/:id/approve-plan`) → records an immutable
  `Approval` (plan hash + base sha + idempotency key), phase → EXECUTE, the
  paused turn resumes with the approval as its tool result.
- **Request changes** → feedback goes back into the same chat; a new plan
  round starts.

## EXECUTE

Write tools are active, jailed to the branch worktree. The agent implements
exactly the approved plan; deviations require a new plan. `finish_execution`
(or the user directly) triggers `POST …/to-preview`:

1. approved memories sync into `.cms/knowledge/`
2. pre-commit validators run (secret scan, symlink ban, unexpected binaries,
   dependency-change flag) — errors block
3. **all changes commit as one self-contained commit** (`Execution` record)
4. phase → PREVIEW

**Undo** any execution via `POST /api/branches/:id/revert {sha}` — a revert
commit under the branch lock; the record is marked `revertedBySha`.

## PREVIEW (read-only)

The workspace shows the visual diff of all changed pages (side-by-side live
iframes, screenshot highlight overlay, onion slider). The agent can discuss
but not edit. Historical versions of the branch are browsable at
`v-<sha>.BASE_DOMAIN`; old versions can be restored as new commits.

- **Request changes** → back to PLAN with feedback.
- **Publish** (`POST …/publish {sha}`) → refused if the branch head moved
  since review (stale approval); otherwise: publish approval bound to the
  exact sha → merge to main under the branch lock → configured DeployFlow
  runs with live log streaming → `Publication` (+ sealed `Artifact` where the
  flow builds).

## PUBLISHED → PLAN

On verified success the branch resets onto the new main and the chat returns
to PLAN for the next request. On failure main stays merged, the publication
is marked failed, and retrying reuses the same sha and sealed artifact — no
blind re-uploads (flows reconcile by commit sha first).

## Autonomy grants

Admins may create grants (actions, path-scope globs, max risk, execution
budget, validity window). When a proposed plan is fully covered by an active
grant, it auto-approves — audited as an autonomy approval and announced in
the chat. Nothing is ever autonomous without an explicit grant.
