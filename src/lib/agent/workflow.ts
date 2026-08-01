/**
 * Workflow-phase transitions (plan §3). Transitions are POST endpoints, never
 * chat text; every transition bumps entityVersion (optimistic concurrency —
 * no last-writer-wins) and is broadcast as phase_changed. When a client tool
 * is pending (propose_plan / finish_execution), the transition resolves it by
 * feeding an answer through the normal turn machinery.
 */
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { acquireTurnLock, broadcast, releaseTurnLock, withBranchLock } from './bus';
import { emitChatState, emitChatStatesForBranch } from './chatState';
import type { DisplayBlock } from '@/lib/messageBlocks';
import { handleChatMessage } from './handler';
import { canSeeOthersChats } from '@/lib/chatAccess';
import {
  branchSha,
  changedFiles,
  commitExecution,
  dirStatus,
  ensureBranch,
  ensureWorktree,
  revertCommit as gitRevert,
} from '@/lib/git/engine';
import { hasErrors, validateWorktree } from '@/lib/validate';
import { syncMemoriesToWorktree } from '@/lib/memory';
import type { WorkflowPhase } from './types';

export class WorkflowError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

interface TransitionOpts {
  chatId: string;
  actor: { id: string; name: string; email: string; role?: string; language?: string };
  expectedVersion?: number;
  idempotencyKey?: string;
}

async function loadChat(chatId: string, viewer?: TransitionOpts['actor']) {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { branch: true },
  });
  if (!chat) throw new WorkflowError('Chat not found', 404);
  // Restricted visibility: a foreign chat is indistinguishable from absent.
  // Internal callers (no viewer) are unaffected.
  if (
    viewer &&
    chat.createdById &&
    chat.createdById !== viewer.id &&
    !(await canSeeOthersChats({ id: viewer.id, role: viewer.role ?? '' }))
  ) {
    throw new WorkflowError('Chat not found', 404);
  }
  return chat;
}

/** What a phase transition may write. Record<string, unknown> went straight
 *  into Prisma — a typo there was an unchecked column name. */
interface PhaseUpdate {
  workflowPhase: WorkflowPhase;
  /** The approved plan; only the two PLAN → EXECUTE paths write it. */
  planJson?: object;
}

async function updatePhase(
  chatId: string,
  fromVersion: number,
  data: PhaseUpdate,
): Promise<void> {
  const res = await prisma.chat.updateMany({
    where: { id: chatId, entityVersion: fromVersion },
    data: { ...data, entityVersion: { increment: 1 } },
  });
  if (res.count === 0) {
    throw new WorkflowError('The chat changed while you were deciding — reload and retry.');
  }
}

/** Resume a paused turn by answering the pending client tool. */
function resumeTurn(
  chatId: string,
  actor: TransitionOpts['actor'],
  text: string,
  attachmentIds?: string[],
): void {
  const lockId = acquireTurnLock(chatId);
  if (!lockId) return; // a turn is already running; the agent will see the new phase next turn
  void (async () => {
    try {
      await handleChatMessage(actor.id, actor.language ?? 'en', {
        chatId,
        type: 'answer',
        text,
        attachmentIds,
      });
    } catch (err) {
      console.error('[workflow] resume error:', err);
      broadcast(chatId, 'error', {
        type: 'error',
        message: err instanceof Error ? err.message : 'Internal error',
      });
    } finally {
      releaseTurnLock(chatId, lockId);
    }
  })();
}

/**
 * The PLAN → EXECUTE move itself, shared by both ways in: the approval card
 * (approvePlan) and the agent recording the plan it would have proposed
 * (startExecution). They differ in who decides and what the caller may pass;
 * hashing the plan, preparing the branch, flipping the phase under the version
 * gate, writing the audit record and emitting state are the same both times.
 *
 * Ordering matters and is the reason this is one function: git preparation
 * happens BEFORE the phase flip, because a failure after it would leave the
 * chat in EXECUTE with no approval and a paused turn nobody resumes. The
 * approval is written after, and a failure there is logged rather than
 * thrown — it is an audit record, and losing it must not strand the chat.
 */
async function enterExecute(args: {
  chat: { id: string; workBranch: string; branch: { name: string } };
  plan: object;
  actorId: string;
  expectedVersion: number;
  idempotencyKey?: string;
}): Promise<void> {
  const planHash = createHash('sha256').update(JSON.stringify(args.plan)).digest('hex');
  // The work branch may not exist yet before the first turn.
  await ensureBranch(args.chat.workBranch, args.chat.branch.name);
  const baseSha = await branchSha(args.chat.workBranch);
  await updatePhase(args.chat.id, args.expectedVersion, {
    workflowPhase: 'execute',
    planJson: args.plan,
  });
  try {
    await prisma.approval.create({
      data: {
        chatId: args.chat.id,
        actorId: args.actorId,
        action: 'plan',
        planHash,
        baseSha,
        idempotencyKey: args.idempotencyKey ?? randomUUID(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  } catch (err) {
    // Audit record only — failing to write it must not strand the transition.
    console.error('[workflow] approval record failed:', err);
  }
  emitChatState(args.chat.id);
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/**
 * PLAN → EXECUTE for a chat in explicit plan mode: binds the pending
 * propose_plan payload as the approved plan. Without the /plan command a plan
 * is never submitted, so nothing pends and this is not part of the flow.
 */
export async function approvePlan(opts: TransitionOpts): Promise<void> {
  const chat = await loadChat(opts.chatId, opts.actor);
  if (chat.workflowPhase !== 'plan') {
    throw new WorkflowError(`Cannot approve a plan in the ${chat.workflowPhase} phase.`);
  }

  const pending = chat.pendingQuestion as { toolName: string; input: object } | null;
  const plan = pending?.toolName === 'propose_plan' ? pending.input : chat.planJson;
  // A plan is an object. The column is JSON, so a scalar left there by
  // something else is not one, and approving it would store nonsense.
  if (!plan || typeof plan !== 'object') {
    throw new WorkflowError('There is no proposed plan to approve yet.');
  }

  await enterExecute({
    chat,
    plan,
    actorId: opts.actor.id,
    expectedVersion: opts.expectedVersion ?? chat.entityVersion,
    idempotencyKey: opts.idempotencyKey,
  });

  if (chat.turnPhase === 'waiting_for_answer') {
    resumeTurn(
      opts.chatId,
      opts.actor,
      `The plan was approved by ${opts.actor.name}. Proceed with the implementation.`,
    );
  }
}

/**
 * PLAN → EXECUTE without an approval card ("shadow plan"): the agent records
 * the plan it would have proposed and keeps going in the same turn. Explicit
 * approval stays available (propose_plan) for changes the user should weigh
 * in on; this path is for requests where the plan holds no real choices.
 * Audited like any approval, with the requesting user as the actor.
 */
export async function startExecution(opts: {
  chatId: string;
  actorId: string;
  plan: object;
}): Promise<void> {
  const chat = await loadChat(opts.chatId);
  if (chat.workflowPhase !== 'plan') {
    throw new WorkflowError(`Cannot start execution from the ${chat.workflowPhase} phase.`);
  }
  await enterExecute({
    chat,
    plan: opts.plan,
    actorId: opts.actorId,
    expectedVersion: chat.entityVersion,
  });
}

/** EXECUTE → PLAN without starting another turn or discarding worktree changes. */
export async function returnToPlan(chatId: string): Promise<void> {
  const chat = await loadChat(chatId);
  if (chat.workflowPhase !== 'execute') {
    throw new WorkflowError(`Cannot return to planning from the ${chat.workflowPhase} phase.`);
  }
  await updatePhase(chatId, chat.entityVersion, { workflowPhase: 'plan' });
  emitChatState(chatId);
}

/** PLAN/EXECUTE → PLAN with feedback (revision round on the same branch). */
export async function requestChanges(opts: TransitionOpts & { feedback: string }): Promise<void> {
  const chat = await loadChat(opts.chatId, opts.actor);
  if (chat.workflowPhase !== 'plan' && chat.workflowPhase !== 'execute') {
    throw new WorkflowError(`Cannot request changes in the ${chat.workflowPhase} phase.`);
  }
  await updatePhase(opts.chatId, opts.expectedVersion ?? chat.entityVersion, {
    workflowPhase: 'plan',
  });
  emitChatState(opts.chatId);

  // Which tool to ask for depends on the chat's mode — in explicit plan mode
  // (the /plan command) start_execution is not even exposed.
  const text = chat.planMode
    ? `Change request from ${opts.actor.name}: ${opts.feedback}\nRevise the plan accordingly and call propose_plan again.`
    : `Change request from ${opts.actor.name}: ${opts.feedback}\nRevise your plan accordingly, then call start_execution with the revised plan and carry it out.`;
  if (chat.turnPhase === 'waiting_for_answer') {
    resumeTurn(opts.chatId, opts.actor, text);
  } else {
    const lockId = acquireTurnLock(opts.chatId);
    if (lockId) {
      void handleChatMessage(opts.actor.id, opts.actor.language ?? 'en', {
        chatId: opts.chatId,
        type: 'message',
        text,
      })
        .catch((err) => console.error('[workflow] request-changes error:', err))
        .finally(() => releaseTurnLock(opts.chatId, lockId));
    }
  }
}

/**
 * PLAN/EXECUTE/PREVIEW → PLAN with an element-edit handoff message (annotated
 * screenshot attached). Modeled on requestChanges, but legal from every
 * pre-publish phase and the message carries attachments.
 */
export async function handoffToPlan(
  opts: TransitionOpts & { text: string; attachmentIds: string[]; blocks?: DisplayBlock[] },
): Promise<void> {
  const chat = await loadChat(opts.chatId, opts.actor);
  if (chat.workflowPhase === 'published') {
    throw new WorkflowError('Cannot hand off to planning from the published phase.');
  }
  if (chat.workflowPhase !== 'plan') {
    await updatePhase(opts.chatId, opts.expectedVersion ?? chat.entityVersion, {
      workflowPhase: 'plan',
    });
    emitChatState(opts.chatId);
  }

  if (chat.turnPhase === 'waiting_for_answer') {
    resumeTurn(opts.chatId, opts.actor, opts.text, opts.attachmentIds);
    return;
  }
  const lockId = acquireTurnLock(opts.chatId);
  if (!lockId) {
    // Unlike requestChanges, dropping the message would orphan the screenshot.
    throw new WorkflowError('A conversation turn is already in progress');
  }
  void handleChatMessage(opts.actor.id, opts.actor.language ?? 'en', {
    chatId: opts.chatId,
    type: 'message',
    text: opts.text,
    attachmentIds: opts.attachmentIds,
    blocks: opts.blocks,
  })
    .catch((err) => console.error('[workflow] handoff error:', err))
    .finally(() => releaseTurnLock(opts.chatId, lockId));
}

/**
 * Finalize the execution for review: sync team knowledge, validate, and commit
 * the leftovers as ONE self-contained commit under the branch mutation lock
 * (plan §3). Reviewing happens IN the execute phase (preview was merged into
 * it), so this settles the branch instead of moving the chat anywhere.
 */
export async function finalizeExecution(opts: TransitionOpts & { summary?: string }): Promise<{
  sha: string | null;
}> {
  const chat = await loadChat(opts.chatId, opts.actor);
  if (chat.workflowPhase !== 'execute') {
    throw new WorkflowError(`Cannot finalize work in the ${chat.workflowPhase} phase.`);
  }

  const pending = chat.pendingQuestion as { toolName: string; input: { summary?: string } } | null;
  const plan = chat.planJson as { summary?: string } | null;
  const summary =
    opts.summary ??
    (pending?.toolName === 'finish_execution' ? pending.input.summary : undefined) ??
    plan?.summary ??
    'CMS change';

  // Version team-approved conventions with this change (.cms/knowledge/)
  const worktree = await ensureWorktree(chat.workBranch, chat.branch.name);
  await syncMemoriesToWorktree(worktree);

  // The agent commits its own work via git_commit — everything except the
  // memory-sync files (.cms/) must already be committed.
  const dirty = await dirStatus(worktree);
  const uncommitted = dirty.filter((p) => !p.startsWith('.cms/'));
  if (uncommitted.length > 0) {
    throw new WorkflowError(
      `Uncommitted changes in the worktree — the agent must commit them with git_commit first:\n${uncommitted
        .map((p) => `- ${p}`)
        .join('\n')}`,
      422,
    );
  }

  // Validation of the memory-sync leftovers before their commit (medved §21).
  // Errors below abort the transition with the list in the message; warnings
  // are recorded in the log. (There used to be a 'validation_result' SSE event
  // here that no client ever listened for.)
  const issues = await validateWorktree(worktree);
  if (issues.length > 0) console.warn(`[workflow] validation issues in ${worktree}:`, issues);
  if (hasErrors(issues)) {
    throw new WorkflowError(
      `Validation failed:\n${issues
        .filter((i) => i.severity === 'error')
        .map((i) => `- ${i.message}`)
        .join('\n')}`,
      422,
    );
  }

  if (dirty.length > 0) {
    const { chatCommitTrailer } = await import('@/lib/git/identity');
    const trailer = await chatCommitTrailer(chat.id, chat.title);
    const syncSha = await withBranchLock(chat.workBranch, () =>
      commitExecution(chat.workBranch, `Sync team knowledge\n\n${trailer}`, {
        name: opts.actor.name,
        email: opts.actor.email,
      }),
    );
    // Record it as an Execution — the snapshot's executionSha derives from
    // Execution rows, and publish binds that sha against the branch HEAD;
    // without the row the sync commit would make them diverge.
    if (syncSha) {
      await prisma.execution.create({
        data: { chatId: chat.id, sha: syncSha, summary: 'Sync team knowledge' },
      });
    }
  }

  // Preview/publish sha = work-branch HEAD when it has commits over the target
  const changed = await changedFiles(chat.workBranch, chat.branch.name);
  const sha = changed.length > 0 ? await branchSha(chat.workBranch) : null;

  // The snapshot carries the refreshed executionSha; the transcript card was
  // already anchored by git_commit's event.
  emitChatState(opts.chatId);

  if (chat.turnPhase === 'waiting_for_answer') {
    resumeTurn(
      opts.chatId,
      opts.actor,
      sha
        ? `All commits are in (HEAD ${sha.slice(0, 8)}); the work is ready for review.`
        : 'No changes were made; the work is ready for review.',
    );
  }
  return { sha };
}

/** Undo an execution: git revert on the owning chat's work branch. */
export async function revertExecution(opts: {
  branchId: string;
  sha: string;
  actor: { id: string; name: string; email: string };
}): Promise<string> {
  const execution = await prisma.execution.findFirst({
    where: { sha: opts.sha, chat: { branchId: opts.branchId } },
    include: { chat: { select: { workBranch: true } } },
  });
  if (!execution) throw new WorkflowError('Execution not found on this branch', 404);
  const workBranch = execution.chat.workBranch;

  const revertSha = await withBranchLock(workBranch, () =>
    gitRevert(workBranch, opts.sha, { name: opts.actor.name, email: opts.actor.email }),
  );

  await prisma.execution.updateMany({
    where: { sha: opts.sha, chat: { branchId: opts.branchId }, revertedBySha: null },
    data: { revertedBySha: revertSha },
  });

  // Notify every chat on the branch (the revert moved the target)
  emitChatStatesForBranch(opts.branchId);
  return revertSha;
}
