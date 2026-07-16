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
import { handleChatMessage } from './handler';
import { commitExecution, branchSha, ensureWorktree, revertCommit as gitRevert } from '@/lib/git/engine';
import { hasErrors, validateWorktree } from '@/lib/validate';
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
}

async function recordApproval(
  chat: { id: string; branch: { name: string } },
  actorId: string,
  action: 'plan' | 'publish',
  opts: { planHash?: string; targetSha?: string; idempotencyKey?: string },
): Promise<void> {
  await prisma.approval.create({
    data: {
      chatId: chat.id,
      actorId,
      action,
      planHash: opts.planHash,
      baseSha: await branchSha(chat.branch.name),
      targetSha: opts.targetSha,
      idempotencyKey: opts.idempotencyKey ?? randomUUID(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
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
  await updatePhase(opts.chatId, opts.expectedVersion ?? chat.entityVersion, {
    workflowPhase: 'execute',
    planJson: plan,
  });
  await recordApproval(chat, opts.actor.id, 'plan', {
    planHash,
    idempotencyKey: opts.idempotencyKey,
  });
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

  // Pre-commit validation of the dirty worktree (secret scan, binaries,
  // symlinks, dependency changes) — errors block the commit (medved §21).
  const worktree = await ensureWorktree(chat.branch.name);
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

  const sha = await withBranchLock(chat.branchId, () =>
    commitExecution(chat.branch.name, `${summary}\n\nChat: ${chat.id}`, {
      name: opts.actor.name,
      email: opts.actor.email,
    }),
  );

  if (sha) {
    await prisma.execution.create({ data: { chatId: chat.id, sha, summary } });
  }

  await updatePhase(opts.chatId, opts.expectedVersion ?? chat.entityVersion, {
    workflowPhase: 'preview',
  });
  emitPhase(opts.chatId, 'preview', { executionSha: sha });
  if (sha) {
    broadcast(opts.chatId, 'execution_committed', { type: 'execution_committed', sha, summary });
  }

  if (chat.turnPhase === 'waiting_for_answer') {
    resumeTurn(
      opts.chatId,
      opts.actor,
      sha
        ? `The execution was committed as ${sha.slice(0, 8)} and the chat moved to the preview phase.`
        : 'No changes were made; the chat moved to the preview phase.',
    );
  }
  return { sha };
}

/** Undo an execution: git revert on the branch (never destructive). */
export async function revertExecution(opts: {
  branchId: string;
  sha: string;
  actor: { id: string; name: string; email: string };
}): Promise<string> {
  const branch = await prisma.branch.findUnique({ where: { id: opts.branchId } });
  if (!branch) throw new WorkflowError('Branch not found', 404);

  const revertSha = await withBranchLock(opts.branchId, () => gitRevert(branch.name, opts.sha));

  await prisma.execution.updateMany({
    where: { sha: opts.sha, revertedBySha: null },
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
  }
  return revertSha;
}
