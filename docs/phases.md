# Workflow phases and approvals

Every chat cycles through three phases. Transitions are **HTTP endpoints,
never chat text** — with one exception noted below, the model cannot advance
the workflow by itself.

```
 PLAN ──approve-plan──► EXECUTE ──publish──► PUBLISHED
  │  └──start_execution────▲ │                   │
  ▲                        │ │                   │
  └── request-changes ◄────┘ └── review here ────┘
  ▲                                              │
  └────── success: branch resets onto new main ──┘
```

## PLAN (read-only)

The agent analyzes the site (read/search/git tools only — write tools are
rejected server-side) and asks clarifying questions. When ready it records the
plan — summary, ordered steps, file list with actions, affected pages, risk
class (`content < template < code < dependency`), open questions — one of two
ways:

- **`propose_plan`** — the turn pauses and the browser renders an approval
  card. For changes the user should weigh in on: options worth choosing
  between, risky or wide-reaching work, anything ambiguous.
  - **Approve** (`POST /api/chats/:id/approve-plan`) → records an immutable
    `Approval` (plan hash + base sha + idempotency key), phase → EXECUTE, the
    paused turn resumes with the approval as its tool result.
  - **Request changes** → feedback goes back into the same chat; a new plan
    round starts.
- **`start_execution`** — a "shadow plan": the same payload is recorded and
  the phase flips to EXECUTE inside the running turn, so implementation
  continues without a stop. For requests that hold no real choices. It writes
  the same audited `Approval` row, with the requesting user as actor.

The agent also keeps a **task list** (`add_tasks`) — the checklist the user
watches while it works. Each task has display text and an optional note only
the agent reads; every turn's system prompt gets the current list back.

## EXECUTE

Write tools are active, jailed to the branch worktree. The agent implements
the plan, commits with `git_commit` at every completed step, and moves its
tasks through `working` → `done` with `update_task`. Deviations that change
the plan materially call `return_to_plan` (the one model-driven transition,
and it only goes backwards).

**Reviewing happens here too.** The compare view (before/after: side-by-side
live iframes, synced scroll, highlight overlay, onion slider) is a stage
window the user opens with the eye button in the tool rail, and the agent can
put it on screen with `open_compare`. Publishing is offered as soon as there
is a committed sha — the user does not leave the phase to look at the work,
and the agent can keep editing while they do.

`finish_execution` signals completion; confirming it calls
`POST …/finalize`, which:

1. syncs approved memories into `.cms/knowledge/`
2. runs pre-commit validators (secret scan, symlink ban, unexpected binaries,
   dependency-change flag) — errors block
3. commits whatever is left as one self-contained commit (`Execution` record)

**Undo** any execution via `POST /api/branches/:id/revert {sha}` — a revert
commit under the branch lock; the record is marked `revertedBySha`.

**Publish** (`POST …/publish {sha}`) → refused if the chat's work branch moved
since review (stale approval); otherwise: publish approval bound to the exact
sha → the work branch merges into its TARGET branch under the target's lock →
the configured DeployFlow runs (only when the target is the default branch;
other targets are pure merges) with live log streaming → `Publication` (+
sealed `Artifact` where the flow builds).

Historical versions of the branch are browsable at `v-<sha>.BASE_DOMAIN`; old
versions can be restored as new commits.

## PUBLISHED → PLAN

On verified success the work branch resets onto the updated target and the
chat returns to PLAN for the next request. On failure main stays merged, the
publication is marked failed, and retrying reuses the same sha and sealed
artifact — no blind re-uploads (flows reconcile by commit sha first).

## Autonomy grants

Admins may create grants (actions, path-scope globs, max risk, execution
budget, validity window). When a proposed plan is fully covered by an active
grant, it auto-approves — audited as an autonomy approval and announced in
the chat.
