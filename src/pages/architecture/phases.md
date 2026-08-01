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
unchanged. That key is a uniqueness constraint, not a replay cache: a repeated
request is rejected, never answered with the first attempt's result. Steering happens through the conversation instead:

- **Request changes** (`POST /api/chats/:id/request-changes`) → feedback goes
  into the chat, the phase returns to PLAN, and the agent plans again.
- Where a decision is genuinely the user's — options worth choosing between,
  something ambiguous — the agent is told to `ask_question` *before* recording
  a plan rather than planning around a guess.

Recording the plan ends the agent's PLAN run: the system prompt and tool set
are built once per run, so the turn continues in a fresh EXECUTE run with the
write tools. The user sees one uninterrupted turn.

### Asking to approve first: the `/plan` command

Sending a message that starts with `/plan` turns on **explicit plan mode** for
that chat. From then on:

- `propose_plan` **replaces** `start_execution` in the tool set — not alongside
  it, so the agent cannot slip past the stop even if it tries.
- The turn ends on the proposal. The browser renders it as an approval card.
- **Approve** (`POST /api/chats/:id/approve-plan`) records the `Approval`,
  moves the phase to EXECUTE and resumes the paused turn, which then
  implements. **Request changes** sends feedback back and the agent proposes
  again.

The mode is a column on the chat, so it survives restarts and holds for the
whole conversation, later planning rounds included. Commands are parsed
server-side from the text that actually arrives; the chip the composer shows
while you type is a preview of that, never the decision itself.

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
sha → **pre-validation**: the tree the merge would produce is written as a
dangling commit and built with the site backend's own build (`astro build` for
Astro, none for static) plus the dist validators — for every flow, before
anything moves; a failure leaves both branches untouched → the work branch
merges into its TARGET branch under the target's lock →
the configured DeployFlow runs (only when the target is the default branch;
other targets are pure merges) with live log streaming → `Publication` (+
sealed `Artifact` where the flow builds).

Historical versions of the branch are browsable at `v-<sha>.BASE_DOMAIN`; old
versions can be restored as new commits.

## After PUBLISHED

On verified success the work branch resets onto the updated target and BOTH
chats — the workflow chat and the deployment chat that ran the automatism —
are archived. The chat is done; the next change starts a new one. (An
archived chat stays readable and keeps its history; it just accepts no
further messages.)

On failure the target stays merged, the publication is marked failed, and
retrying reuses the same sha and sealed artifact — no blind re-uploads (flows
reconcile by commit sha first).

## Commands

A message may start with a `/command`, which switches something on for the
chat. They are parameterless by design — a command is a mode switch you can
type, not an argument syntax. Typing `/` in the composer opens an autocomplete;
the command a message was sent with is kept and shown as a chip beside it in
the transcript.

| Command | Effect |
|---|---|
| `/plan` | Explicit plan mode: the agent proposes a plan and waits for your approval before implementing. |

Adding one is a single entry in `src/lib/commands/index.ts` — the parser, the
autocomplete and the server-side validation all read the same registry.
