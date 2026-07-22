/**
 * Streamed chat state (phase 1 of the streamed-chat-state plan).
 *
 * One server-computed snapshot per chat, re-broadcast IN FULL as an SSE
 * `state` event on every change and returned by /api/chat/history — snapshot
 * and stream share this builder by construction, so they cannot drift. The
 * client applies snapshots by plain replacement (server wins); `seq`/`epoch`
 * only guard against out-of-order delivery, there is no patch protocol.
 *
 * Out of scope by design: the transcript token stream, `publish_log` /
 * `automatism` message appends (append-only, transcript-like), and local UI
 * state. Tabs are per-user: a snapshot carries tabs ONLY when the change
 * that triggered it was a tabs write (opts.tabs), null means "no tab info",
 * never "no tabs".
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { broadcast, hasActiveTurn } from './bus';

export interface ChatStateTabs {
  tabs: string[];
  activeIndex: number;
  /** The user whose tabs these are — other users' clients must ignore them. */
  byUserId: string;
}

export interface ChatStateSnapshot {
  /** Monotonic per chat within one server process — stale-drop guard. */
  seq: number;
  /** Random per server process — a restart resets seq; clients reset with it. */
  epoch: string;
  chatId: string;
  title: string;
  kind: string;
  archived: boolean;
  workflowPhase: string;
  branchId: string;
  workBranch: string;
  planJson: unknown;
  /** Latest publishable (non-reverted) execution sha, or null. */
  executionSha: string | null;
  executions: Array<{
    sha: string;
    summary: string;
    revertedBySha: string | null;
    createdAt: Date | string;
  }>;
  /** Latest publication — only in the published phase (a request-changes
   *  round after a publish must not resurrect the previous card). */
  publication: {
    id: string;
    sha: string;
    status: string;
    log: string;
    externalUrl: string | null;
  } | null;
  automatism: {
    chatId: string;
    automatismType: string;
    status: string;
    step: number;
    steps: string[];
    lastError: string | null;
  } | null;
  targetAhead: boolean;
  tabs: ChatStateTabs | null;
  /** Remote turn state (phase 5): the client DERIVES its composer/card
   *  phase from these; stream events (question/done/error) remain the
   *  transcript-ordered fast path. */
  turnPhase: string;
  /** Persisted active work has no in-process owner (usually after restart). */
  canResume: boolean;
  /** Only present while turnPhase === 'waiting_for_answer'. */
  pendingQuestion: { toolName: string; input: Record<string, unknown> } | null;
  lastError: string | null;
}

// globalThis-backed for the same HMR reason as bus.ts: a split instance
// would fork the seq counters and epoch mid-session.
interface ChatStateGlobals {
  epoch: string;
  seqs: Map<string, number>;
  scheduled: Map<string, EmitOptsInternal>;
}
interface EmitOptsInternal {
  clientId?: string;
  tabs?: ChatStateTabs;
}
const g = globalThis as unknown as { __cmsChatState?: ChatStateGlobals };
const globals: ChatStateGlobals = (g.__cmsChatState ??= {
  epoch: randomUUID(),
  seqs: new Map(),
  scheduled: new Map(),
});
const EPOCH = globals.epoch;
const seqs = globals.seqs;

export async function buildChatState(
  chatId: string,
  tabs: ChatStateTabs | null = null,
): Promise<ChatStateSnapshot | null> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      executions: { orderBy: { createdAt: 'asc' } },
      branch: { select: { name: true } },
    },
  });
  if (!chat) return null;

  // Step names come from registered automatism defs — publisher registers them
  await import('@/lib/publish/publisher');
  const { automatismStateFor } = await import('@/lib/automatism');
  const automatism = await automatismStateFor(chatId);

  let targetAhead = false;
  if (chat.kind === 'workflow') {
    const { branchAheadCount } = await import('@/lib/git/engine');
    targetAhead = await branchAheadCount(chat.workBranch, chat.branch.name)
      .then((n) => n > 0)
      .catch(() => false);
  }

  const publication =
    chat.workflowPhase === 'published'
      ? await prisma.publication.findFirst({
          where: { chatId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, sha: true, status: true, log: true, externalUrl: true },
        })
      : null;

  const publishable = chat.executions.filter((e) => !e.revertedBySha);

  return {
    seq: 0, // stamped by emitChatState; history snapshots stay at 0
    epoch: EPOCH,
    chatId,
    title: chat.title,
    kind: chat.kind,
    archived: Boolean(chat.archivedAt),
    workflowPhase: chat.workflowPhase,
    branchId: chat.branchId,
    workBranch: chat.workBranch,
    planJson: chat.planJson,
    executionSha: publishable[publishable.length - 1]?.sha ?? null,
    executions: chat.executions.map((e) => ({
      sha: e.sha,
      summary: e.summary,
      revertedBySha: e.revertedBySha,
      createdAt: e.createdAt,
    })),
    publication,
    automatism,
    targetAhead,
    tabs,
    turnPhase: chat.turnPhase,
    canResume:
      (chat.turnPhase === 'running' || chat.turnPhase === 'tool_pending') &&
      !hasActiveTurn(chatId),
    pendingQuestion:
      chat.turnPhase === 'waiting_for_answer' && chat.pendingQuestion
        ? (chat.pendingQuestion as { toolName: string; input: Record<string, unknown> })
        : null,
    lastError: chat.lastError,
  };
}

/**
 * Emit snapshots for EVERY live chat on a branch — for changes that affect
 * them all at once (the target branch moved: publish merge, revert), where
 * per-chat facts like `targetAhead` go stale without their own event.
 */
export function emitChatStatesForBranch(branchId: string): void {
  void prisma.chat
    .findMany({ where: { branchId, archivedAt: null }, select: { id: true } })
    .then((chats) => {
      for (const c of chats) emitChatState(c.id);
    })
    .catch((err) => {
      console.warn(`[chatState] branch emit for ${branchId} failed:`, err);
    });
}

/**
 * Snapshot at the CURRENT seq (no bump) — the SSE connect replay. A client
 * that already applied this seq skips it; a fresh client applies it.
 */
export async function currentChatState(chatId: string): Promise<ChatStateSnapshot | null> {
  const state = await buildChatState(chatId);
  if (state) state.seq = seqs.get(chatId) ?? 0;
  return state;
}

interface EmitOpts {
  /** Originating browser session — that client ignores its own echo. */
  clientId?: string;
  tabs?: ChatStateTabs;
}

const scheduled = globals.scheduled;

/**
 * Broadcast a fresh snapshot to the chat's SSE subscribers. Coalesces
 * same-tick calls (one transition touching several tables emits once).
 * Fire-and-forget and fail-soft: state emission must never break the
 * mutation that triggered it.
 */
export function emitChatState(chatId: string, opts: EmitOpts = {}): void {
  const pending = scheduled.get(chatId);
  if (pending) {
    Object.assign(pending, opts);
    return;
  }
  scheduled.set(chatId, { ...opts });
  queueMicrotask(() => {
    const o = scheduled.get(chatId);
    scheduled.delete(chatId);
    void (async () => {
      try {
        const state = await buildChatState(chatId, o?.tabs ?? null);
        if (!state) return;
        state.seq = (seqs.get(chatId) ?? 0) + 1;
        seqs.set(chatId, state.seq);
        broadcast(chatId, 'state', { type: 'state', state, clientId: o?.clientId });
      } catch (err) {
        console.warn(
          `[chatState] emit for ${chatId} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    })();
  });
}
