/**
 * Automatisms — agent-less flows attached to a chat (e.g. the deploy
 * pipeline). A registered type is an ordered list of named steps. The engine
 * runs them server-side, posting each event as a role:'automatism' message
 * into the chat (persisted, broadcast live, part of the agent's LLM context).
 *
 * On a step failure the automatism pauses, the failure context is posted into
 * the chat where the agent can act (a step may direct this elsewhere, e.g.
 * merge conflicts → the workflow chat) and the agent is auto-invoked there.
 * Once it has fixed the cause it calls resume_automatism: the failed step
 * re-runs and the flow continues — steps must therefore be retry-safe.
 */
import { prisma } from '@/lib/db';
import { acquireTurnLock, broadcast, releaseTurnLock } from '@/lib/agent/bus';
import { tmsg, type TranslatedMessage } from '@/lib/i18n';

export type AutomatismData = Record<string, unknown> & { actorId: string };

/** Messages posted into the chat: plain string or a TranslatedMessage
 *  (i18n key + params + rendered-English fallback, localized per viewer). */
export type AutomatismMessage = string | TranslatedMessage;

export interface AutomatismStep {
  name: string;
  run(data: AutomatismData, post: (msg: AutomatismMessage) => Promise<void>): Promise<void>;
}

export interface AutomatismDef {
  type: string;
  steps: AutomatismStep[];
}

/** Thrown by steps to direct the failure handling (agent chat, message). */
export class AutomatismFailure extends Error {
  /** Chat the agent is invoked in (defaults to the automatism's chat). */
  agentChatId?: string;
  /** Localizable form of the failure message, when the step provides one. */
  tm?: TranslatedMessage;
  constructor(message: AutomatismMessage, agentChatId?: string) {
    super(typeof message === 'string' ? message : message.fallback);
    if (typeof message !== 'string') this.tm = message;
    this.agentChatId = agentChatId;
  }
}

const types = new Map<string, AutomatismDef>();

export function registerAutomatism(def: AutomatismDef): void {
  types.set(def.type, def);
}

/** Step-progress snapshot shown in the UI (phase-bar equivalent). */
export interface AutomatismState {
  chatId: string;
  automatismType: string;
  status: string;
  step: number;
  steps: string[];
  lastError: string | null;
}

function emitState(s: AutomatismState): void {
  // The full snapshot carries the step bar (lazy import breaks the
  // automatism ⇄ publisher ⇄ chatState registration cycle).
  void import('@/lib/agent/chatState').then(({ emitChatState }) => emitChatState(s.chatId));
}

const stateOf = (
  row: { chatId: string; type: string; status: string; step: number; lastError?: string | null },
  overrides: Partial<AutomatismState> = {},
): AutomatismState => ({
  chatId: row.chatId,
  automatismType: row.type,
  status: row.status,
  step: row.step,
  steps: types.get(row.type)?.steps.map((s) => s.name) ?? [],
  lastError: row.lastError ?? null,
  ...overrides,
});

/** Latest automatism of a chat, for rendering its step bar (null = none). */
export async function automatismStateFor(chatId: string): Promise<AutomatismState | null> {
  const row = await prisma.automatism.findFirst({
    where: { chatId },
    orderBy: { createdAt: 'desc' },
  });
  return row ? stateOf(row) : null;
}

/**
 * Append a role:'automatism' message to a chat and broadcast it. Ordinals are
 * assigned by read-back; a concurrent agent turn can race the unique
 * (chatId, ordinal) constraint — retry a few times.
 */
export async function postAutomatismMessage(chatId: string, msg: AutomatismMessage): Promise<void> {
  // content carries the rendered English text (LLM context, compatibility);
  // the TranslatedMessage container goes into contentBlocks for per-viewer
  // localization at render time.
  const content = typeof msg === 'string' ? msg : msg.fallback;
  const tm = typeof msg === 'string' ? null : msg;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const last = await prisma.message.findFirst({
        where: { chatId },
        orderBy: { ordinal: 'desc' },
        select: { ordinal: true },
      });
      await prisma.message.create({
        data: {
          chatId,
          role: 'automatism',
          content,
          ...(tm ? { contentBlocks: tm as object } : {}),
          ordinal: (last?.ordinal ?? -1) + 1,
        },
      });
      break;
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  broadcast(chatId, 'automatism', { type: 'automatism', content, tm });
}

export async function startAutomatism(
  type: string,
  chatId: string,
  data: AutomatismData,
): Promise<string> {
  if (!types.has(type)) throw new Error(`Unknown automatism type: ${type}`);
  const row = await prisma.automatism.create({ data: { chatId, type, data: data as object } });
  void advance(row.id);
  return row.id;
}

/** Resume a paused automatism: the failed step re-runs, then the rest. */
export async function resumeAutomatism(id: string): Promise<boolean> {
  const gate = await prisma.automatism.updateMany({
    where: { id, status: 'paused' },
    data: { status: 'running', lastError: null },
  });
  if (gate.count === 0) return false;
  void advance(id);
  return true;
}

async function advance(id: string): Promise<void> {
  const row = await prisma.automatism.findUnique({ where: { id } });
  if (!row || (row.status !== 'running')) return;
  const def = types.get(row.type);
  if (!def) {
    await prisma.automatism.update({
      where: { id },
      data: { status: 'failed', lastError: `Unknown automatism type: ${row.type}` },
    });
    return;
  }

  const data = row.data as AutomatismData;
  const post = (msg: AutomatismMessage) => postAutomatismMessage(row.chatId, msg);

  for (let step = row.step; step < def.steps.length; step++) {
    const s = def.steps[step];
    await prisma.automatism.update({ where: { id }, data: { step, data: data as object } });
    emitState(stateOf({ ...row, status: 'running', step }));
    try {
      await s.run(data, post);
    } catch (err) {
      await pauseOnFailure(id, row, data, step, s.name, err);
      return;
    }
  }

  await prisma.automatism.update({ where: { id }, data: { status: 'done', data: data as object } });
  emitState(stateOf({ ...row, status: 'done', step: def.steps.length }));
}

async function pauseOnFailure(
  id: string,
  row: { chatId: string; type: string },
  data: AutomatismData,
  step: number,
  stepName: string,
  err: unknown,
): Promise<void> {
  const chatId = row.chatId;
  const message = err instanceof Error ? err.message : String(err);
  const agentChatId = (err instanceof AutomatismFailure && err.agentChatId) || chatId;
  console.error(`[automatism] ${id} paused at step "${stepName}":`, err);

  await prisma.automatism.update({
    where: { id },
    data: { status: 'paused', lastError: message, agentChatId, data: data as object },
  });
  emitState(stateOf({ ...row, status: 'paused', step, lastError: message }));

  // The step's own failure text nests into the wrapper message and resolves
  // in the viewer's locale; plain errors stay verbatim as a string param.
  const error = (err instanceof AutomatismFailure && err.tm) || message;
  if (agentChatId !== chatId) {
    await postAutomatismMessage(chatId, tmsg('automatism.takeover', { step: stepName, error }));
  }
  await postAutomatismMessage(agentChatId, tmsg('automatism.stepFailed', { step: stepName, error }));
  await invokeAgent(agentChatId, data.actorId);
}

/**
 * Run an agent turn in a chat off the automatism messages already appended
 * (a 'continue' turn — nothing else is added to the transcript). Waits for
 * the chat's turn lock in case the agent is mid-turn.
 */
async function invokeAgent(chatId: string, userId: string): Promise<void> {
  const start = Date.now();
  let lockId = acquireTurnLock(chatId);
  while (!lockId && Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 2000));
    lockId = acquireTurnLock(chatId);
  }
  if (!lockId) {
    console.error(`[automatism] chat=${chatId} agent turn lock timeout — not invoking`);
    return;
  }
  try {
    const [user, chat] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { language: true } }),
      prisma.chat.findUnique({ where: { id: chatId }, select: { turnPhase: true } }),
    ]);
    // Dynamic import: handler → tools → resume_automatism → this module
    const { handleChatMessage } = await import('@/lib/agent/handler');
    // A pending client-tool question (e.g. the finish-execution card after a
    // completed execution) makes a 'continue' turn refuse with "answer the
    // pending question instead" — and the failure would then sit unhandled
    // forever. Answer the question with the interruption so the turn runs.
    const body =
      chat?.turnPhase === 'waiting_for_answer'
        ? {
            chatId,
            type: 'answer' as const,
            text:
              'An automatism step failed and needs attention — handle the failure described in ' +
              'the messages above first; re-raise this question afterwards if it is still relevant.',
          }
        : { chatId, type: 'continue' as const, text: '' };
    await handleChatMessage(userId, user?.language ?? 'en', body);
  } catch (err) {
    console.error('[automatism] agent invocation failed:', err);
    const message = err instanceof Error ? err.message : 'Internal error';
    await prisma.chat.updateMany({ where: { id: chatId }, data: { lastError: message } }).catch(() => {});
    broadcast(chatId, 'error', { type: 'error', message });
  } finally {
    releaseTurnLock(chatId, lockId);
  }
}

/**
 * Boot recovery — automatisms still 'running' belonged to a process that
 * died mid-step; steps are retry-safe, so re-run them from the persisted
 * step. Paused ones keep waiting for their resume.
 */
export async function recoverAutomatisms(): Promise<void> {
  await import('@/lib/publish/publisher'); // registers automatism types
  const orphans = await prisma.automatism.findMany({ where: { status: 'running' } });
  for (const row of orphans) {
    console.log(`[automatism] recovering ${row.id} (${row.type}) from step ${row.step}`);
    try {
      await postAutomatismMessage(row.chatId, tmsg('automatism.recovered', { step: row.step + 1 }));
    } catch (err) {
      console.error('[automatism] recovery notice failed:', err);
    }
    void advance(row.id);
  }
}

/** Newest paused automatism actionable from `chatId` (home or agent chat). */
export async function findPausedAutomatism(chatId: string) {
  return prisma.automatism.findFirst({
    where: { status: 'paused', OR: [{ chatId }, { agentChatId: chatId }] },
    orderBy: { updatedAt: 'desc' },
  });
}
