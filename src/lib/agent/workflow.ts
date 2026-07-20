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
import { emitChatState } from './chatState';
import { handleChatMessage } from './handler';
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
  actor: { id: string; name: string; email: string; language?: string };
  expectedVersion?: number;
  idempotencyKey?: string;
}

async function loadChat(chatId: string) {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { branch: true },
  });
  if (!chat) throw new WorkflowError('Chat not found', 404);
  return chat;
}

async function updatePhase(
  chatId: string,
  fromVersion: number,
  data: Record<string, unknown>,
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
function resumeTurn(chatId: string, actor: TransitionOpts['actor'], text: string): void {
  const lockId = acquireTurnLock(chatId);
  if (!lockId) return; // a turn is already running; the agent will see the new phase next turn
  void (async () => {
    try {
      await handleChatMessage(actor.id, actor.language ?? 'en', { chatId, type: 'answer', text });
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

function emitPhase(chatId: string, workflowPhase: WorkflowPhase, extra: object = {}): void {
  broadcast(chatId, 'phase_changed', { type: 'phase_changed', workflowPhase, ...extra });
  emitChatState(chatId); // streamed-state phase 1: full snapshot alongside
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/** PLAN → EXECUTE. Binds the pending propose_plan payload as the approved plan. */
export async function approvePlan(opts: TransitionOpts): Promise<void> {
  const chat = await loadChat(opts.chatId);
  if (chat.workflowPhase !== 'plan') {
    throw new WorkflowError(`Cannot approve a plan in the ${chat.workflowPhase} phase.`);
  }

  const pending = chat.pendingQuestion as { toolName: string; input: object } | null;
  const plan = pending?.toolName === 'propose_plan' ? pending.input : chat.planJson;
  if (!plan) throw new WorkflowError('There is no proposed plan to approve yet.');

  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  // Git prep BEFORE the phase flip — a failure after updatePhase would leave
  // the chat in execute with no approval and the paused turn never resumed.
  // (The work branch may not exist yet before the first turn.)
  await ensureBranch(chat.workBranch, chat.branch.name);
  const baseSha = await branchSha(chat.workBranch);
  await updatePhase(opts.chatId, opts.expectedVersion ?? chat.entityVersion, {
    workflowPhase: 'execute',
    planJson: plan,
  });
  try {
    await prisma.approval.create({
      data: {
        chatId: chat.id,
        actorId: opts.actor.id,
        action: 'plan',
        planHash,
        baseSha,
        idempotencyKey: opts.idempotencyKey ?? randomUUID(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  } catch (err) {
    // Audit record only — failing to write it must not strand the transition.
    console.error('[workflow] approval record failed:', err);
  }
  emitPhase(opts.chatId, 'execute');

  if (chat.turnPhase === 'waiting_for_answer') {
    resumeTurn(
      opts.chatId,
      opts.actor,
      `The plan was approved by ${opts.actor.name}. Proceed with the implementation.`,
    );
  }
}

/** PLAN/PREVIEW → PLAN with feedback (revision round on the same branch). */
export async function requestChanges(opts: TransitionOpts & { feedback: string }): Promise<void> {
  const chat = await loadChat(opts.chatId);
  if (chat.workflowPhase !== 'plan' && chat.workflowPhase !== 'preview') {
    throw new WorkflowError(`Cannot request changes in the ${chat.workflowPhase} phase.`);
  }
  await updatePhase(opts.chatId, opts.expectedVersion ?? chat.entityVersion, {
    workflowPhase: 'plan',
  });
  emitPhase(opts.chatId, 'plan');

  const text = `Change request from ${opts.actor.name}: ${opts.feedback}\nRevise the plan accordingly and call propose_plan again.`;
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
 * EXECUTE → PREVIEW. Stages and commits all worktree changes as ONE
 * self-contained commit under the branch mutation lock (plan §3).
 */
export async function toPreview(opts: TransitionOpts & { summary?: string }): Promise<{
  sha: string | null;
}> {
  const chat = await loadChat(opts.chatId);
  if (chat.workflowPhase !== 'execute') {
    throw new WorkflowError(`Cannot move to preview from the ${chat.workflowPhase} phase.`);
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
  const issues = await validateWorktree(worktree);
  if (issues.length > 0) {
    broadcast(opts.chatId, 'validation_result', { type: 'validation_result', issues });
  }
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
    await withBranchLock(chat.workBranch, () =>
      commitExecution(chat.workBranch, `Sync team knowledge\n\n${trailer}`, {
        name: opts.actor.name,
        email: opts.actor.email,
      }),
    );
  }

  // Preview/publish sha = work-branch HEAD when it has commits over the target
  const changed = await changedFiles(chat.workBranch, chat.branch.name);
  const sha = changed.length > 0 ? await branchSha(chat.workBranch) : null;

  await updatePhase(opts.chatId, opts.expectedVersion ?? chat.entityVersion, {
    workflowPhase: 'preview',
  });
  emitPhase(opts.chatId, 'preview', { executionSha: sha });
  if (sha) {
    // Cards are broadcast per git_commit; this only refreshes executionSha
    // for clients (execution_committed dedupes by sha client-side).
    broadcast(opts.chatId, 'execution_committed', { type: 'execution_committed', sha, summary });
  }

  if (chat.turnPhase === 'waiting_for_answer') {
    resumeTurn(
      opts.chatId,
      opts.actor,
      sha
        ? `All commits are in (HEAD ${sha.slice(0, 8)}); the chat moved to the preview phase.`
        : 'No changes were made; the chat moved to the preview phase.',
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

  // Notify every chat on the branch
  const chats = await prisma.chat.findMany({ where: { branchId: opts.branchId }, select: { id: true } });
  for (const c of chats) {
    broadcast(c.id, 'execution_reverted', {
      type: 'execution_reverted',
      sha: opts.sha,
      revertSha,
      by: opts.actor.name,
    });
    emitChatState(c.id);
  }
  return revertSha;
}
