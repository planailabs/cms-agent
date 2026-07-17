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

export type AutomatismData = Record<string, unknown> & { actorId: string };

export interface AutomatismStep {
  name: string;
  run(data: AutomatismData, post: (text: string) => Promise<void>): Promise<void>;
}

export interface AutomatismDef {
  type: string;
  steps: AutomatismStep[];
}

/** Thrown by steps to direct the failure handling (agent chat, message). */
export class AutomatismFailure extends Error {
  /** Chat the agent is invoked in (defaults to the automatism's chat). */
  agentChatId?: string;
  constructor(message: string, agentChatId?: string) {
    super(message);
    this.agentChatId = agentChatId;
  }
}

const types = new Map<string, AutomatismDef>();

export function registerAutomatism(def: AutomatismDef): void {
  types.set(def.type, def);
}

/**
 * Append a role:'automatism' message to a chat and broadcast it. Ordinals are
 * assigned by read-back; a concurrent agent turn can race the unique
 * (chatId, ordinal) constraint — retry a few times.
 */
export async function postAutomatismMessage(chatId: string, content: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const last = await prisma.message.findFirst({
        where: { chatId },
        orderBy: { ordinal: 'desc' },
        select: { ordinal: true },
      });
      await prisma.message.create({
        data: { chatId, role: 'automatism', content, ordinal: (last?.ordinal ?? -1) + 1 },
      });
      break;
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  broadcast(chatId, 'automatism', { type: 'automatism', content });
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
  const post = (text: string) => postAutomatismMessage(row.chatId, text);

  for (let step = row.step; step < def.steps.length; step++) {
    const s = def.steps[step];
    await prisma.automatism.update({ where: { id }, data: { step, data: data as object } });
    try {
      await s.run(data, post);
    } catch (err) {
      await pauseOnFailure(id, row.chatId, data, s.name, err);
      return;
    }
  }

  await prisma.automatism.update({ where: { id }, data: { status: 'done', data: data as object } });
}

async function pauseOnFailure(
  id: string,
  chatId: string,
  data: AutomatismData,
  stepName: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const agentChatId = (err instanceof AutomatismFailure && err.agentChatId) || chatId;
  console.error(`[automatism] ${id} paused at step "${stepName}":`, err);

  await prisma.automatism.update({
    where: { id },
    data: { status: 'paused', lastError: message, agentChatId, data: data as object },
  });

  const context =
    `Step "${stepName}" FAILED:\n${message}\n\n` +
    `Investigate and fix the cause, then call resume_automatism to re-run the ` +
    `failed step and continue. If a human decision is needed, explain what and why.`;
  if (agentChatId !== chatId) {
    await postAutomatismMessage(chatId, `Step "${stepName}" failed — the agent takes over in another chat.\n${message}`);
  }
  await postAutomatismMessage(agentChatId, context);
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
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { language: true } });
    // Dynamic import: handler → tools → resume_automatism → this module
    const { handleChatMessage } = await import('@/lib/agent/handler');
    await handleChatMessage(userId, user?.language ?? 'en', { chatId, type: 'continue', text: '' });
  } catch (err) {
    console.error('[automatism] agent invocation failed:', err);
    const message = err instanceof Error ? err.message : 'Internal error';
    await prisma.chat.updateMany({ where: { id: chatId }, data: { lastError: message } }).catch(() => {});
    broadcast(chatId, 'error', { type: 'error', message });
  } finally {
    releaseTurnLock(chatId, lockId);
  }
}

/** Newest paused automatism actionable from `chatId` (home or agent chat). */
export async function findPausedAutomatism(chatId: string) {
  return prisma.automatism.findFirst({
    where: { status: 'paused', OR: [{ chatId }, { agentChatId: chatId }] },
    orderBy: { updatedAt: 'desc' },
  });
}
