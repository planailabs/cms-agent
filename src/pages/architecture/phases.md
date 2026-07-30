---
layout: ../../components/architecture/Shell.astro
title: Workflow phases and approvals
lead: What the agent may do in each phase, how a plan becomes an immutable approval, and the one transition the model drives itself.
---

Every chat cycles through three phases. Transitions are **HTTP endpoints,
never chat text** — with one exception noted below, the model cannot advance
the workflow by itself.

The transitions are drawn in
[the workflow phase machine](/architecture#workflow-phase); this page is the
prose behind them.

## PLAN (read-only)

The agent analyzes the site (read/search/git tools only — write tools are
rejected server-side) and asks clarifying questions. When ready it records the
plan — summary, ordered steps, file list with actions, affected pages, risk
class (`content < template < code < dependency`), open questions — with
**`start_execution`**, and implements it.

There is no approval card and no approve step: a plan is something the user
reads while the work happens, not a form they sign before it can start. The
call still writes the immutable `Approval` row (plan hash + base sha +
idempotency key) with the requesting user as actor, so the audit trail is
unchanged. Steering happens through the conversation instead:

- **Request changes** (`POST /api/chats/:id/request-changes`) → feedback goes
  into the chat, the phase returns to PLAN, and the agent plans again.
- Where a decision is genuinely the user's — options worth choosing between,
  something ambiguous — the agent is told to `ask_question` *before* recording
  a plan rather than planning around a guess.

Recording the plan ends the agent's PLAN run: the system prompt and tool set
are built once per run, so the turn continues in a fresh EXECUTE run with the
write tools. The user sees one uninterrupted turn.

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
budget, validity window). These were the way a plan could clear an approval
card without a human; with plans no longer submitted for approval, nothing
currently consumes them — the grant machinery is inert until it is either
removed or rebound to a decision that still exists (publishing is the obvious
candidate).
