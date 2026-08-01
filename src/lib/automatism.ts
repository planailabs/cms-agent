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
import { acquireTurnLock, broadcast, hasActiveTurn, releaseTurnLock } from '@/lib/agent/bus';
import { tmsg, type TranslatedMessage } from '@/lib/i18n';
import { createChatMessage, isOrdinalCollision } from '@/lib/agent/persistence';

export type AutomatismData = Record<string, unknown> & { actorId: string };

/** Messages posted into the chat: plain string or a TranslatedMessage
 *  (i18n key + params + rendered-English fallback, localized per viewer). */
export type AutomatismMessage = string | TranslatedMessage;

export interface AutomatismStep {
  name: string;
  /**
   * Tools the repair turn for THIS step gets, beyond the common core below.
   *
   * A paused step is a specific job — resolve these conflicts, fix this
   * build, get this page rendering again — and the tools it needs follow from
   * the job, not from whatever workflow phase the chat happens to sit in.
   * Inheriting the phase meant either handing a planning chat write tools by
   * force (the flow used to move the chat into EXECUTE for the duration) or
   * leaving the agent unable to do the very thing it was invoked for.
   *
   * Unset: the step declares no repair of its own and falls back to the
   * chat's phase tools, which is the old behaviour for flows that want it.
   */
  repairTools?: string[];
  run(data: AutomatismData, post: (msg: AutomatismMessage) => Promise<void>): Promise<void>;
}

export interface AutomatismDef {
  type: string;
  steps: AutomatismStep[];
}

/**
 * Always in a repair turn: how to look around, how to ask, and the two ways
 * out — resume when it is fixed, hand it to a human when it is not. Listing
 * these per step would be noise that hides the tools that actually differ.
 */
export const REPAIR_CORE_TOOLS = [
  'read_file',
  'list_dir',
  'grep',
  'git_log',
  'git_status',
  'git_diff',
  'ask_question',
  'use_skill',
  'query_skills',
  'query_mcps',
  'load_mcp',
  'unload_mcp',
  'resume_automatism',
  'needs_human_attention',
  'set_chat_title',
  'user_ui_change_language',
] as const;

/** What a paused automatism grants the chat repairing it. */
export interface RepairContext {
  automatismId: string;
  type: string;
  /** Index and name of the failed step. */
  step: number;
  stepName: string;
  /** Exactly the tools this repair turn may see and call. */
  tools: Set<string>;
}

/** The tools a step's repair turn gets, or null when it declares none. */
export function repairToolsFor(type: string, step: number): Set<string> | null {
  const declared = types.get(type)?.steps[step]?.repairTools;
  if (!declared) return null;
  return new Set([...REPAIR_CORE_TOOLS, ...declared]);
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
 * (chatId, ordinal) constraint — re-read and retry on THAT, and only that.
 */
export async function postAutomatismMessage(chatId: string, msg: AutomatismMessage): Promise<void> {
  // content carries the rendered English text (LLM context, compatibility);
  // the TranslatedMessage container goes into contentBlocks for per-viewer
  // localization at render time.
  const content = typeof msg === 'string' ? msg : msg.fallback;
  const tm = typeof msg === 'string' ? null : msg;
  for (let attempt = 0; ; attempt++) {
    const last = await prisma.message.findFirst({
      where: { chatId },
      orderBy: { ordinal: 'desc' },
      select: { ordinal: true },
    });
    try {
      await createChatMessage(
        prisma,
        { chatId, role: 'automatism', content, contentBlocks: tm },
        (last?.ordinal ?? -1) + 1,
      );
      break;
    } catch (err) {
      // Only a lost race for the ordinal is worth another attempt. Retrying
      // everything meant a broken payload or a dead connection was tried five
      // times and then reported as if it had been a race.
      if (!isOrdinalCollision(err) || attempt >= 4) throw err;
    }
  }
  broadcast(chatId, 'automatism', { type: 'automatism', content, tm });
}

/**
 * Chats an automatism would run underneath: its own, plus the workflow chat
 * whose worktree the steps actually touch (a deploy lives on its own
 * deployment chat but merges the workflow chat's branch).
 */
const affectedChats = (chatId: string, data: AutomatismData): string[] => {
  const workflowChatId = (data as { workflowChatId?: string }).workflowChatId;
  return workflowChatId && workflowChatId !== chatId ? [chatId, workflowChatId] : [chatId];
};

/**
 * Thrown when an automatism would start on top of a live turn. Endpoints turn
 * it into a 409 — see WorkflowError in agent/workflow.ts.
 */
export class TurnInProgressError extends Error {
  readonly status = 409;
}

export async function startAutomatism(
  type: string,
  chatId: string,
  data: AutomatismData,
): Promise<string> {
  // An automatism rewrites the very worktree a running turn is editing — a
  // sync rebases the branch under the agent's feet, a deploy merges a tree it
  // is still writing to. The steps hold the branch lock for their git calls,
  // but that only serializes commands; it cannot make a half-finished
  // execution coherent. So the whole flow is refused while a turn is live.
  for (const affected of affectedChats(chatId, data)) {
    if (hasActiveTurn(affected)) {
      throw new TurnInProgressError(
        'The agent is working in this chat — wait for the turn to finish, then try again.',
      );
    }
  }
  const id = await createAutomatismRow(prisma, type, chatId, data);
  kickAutomatism(id);
  return id;
}

/**
 * The durable half: write the row, run nothing.
 *
 * `client` may be a transaction, which is the point — a publish creates the
 * approval, the phase flip, the deployment chat, the publication, its first
 * message and this row as ONE unit. Starting the flow from inside that
 * transaction would run steps against rows no other connection can see yet.
 */
export async function createAutomatismRow(
  client: { automatism: { create: typeof prisma.automatism.create } },
  type: string,
  chatId: string,
  data: AutomatismData,
): Promise<string> {
  if (!types.has(type)) throw new Error(`Unknown automatism type: ${type}`);
  const row = await client.automatism.create({
    data: { chatId, type, data: data as object },
    select: { id: true },
  });
  return row.id;
}

/** Start running a durable automatism. Safe after a crash: boot recovery does
 *  the same thing for rows left `running`. */
export function kickAutomatism(id: string): void {
  void advance(id);
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
 * How long a failed step waits for the chat's turn lock before giving up.
 *
 * This is the auto-repair path, so giving up is expensive: the flow stays
 * paused and the person who pressed Publish sees nothing happen. The wait has
 * to outlast a real turn — an EXECUTE turn that installs dependencies and runs
 * a build takes minutes, and the common case for a resumed step failing again
 * is precisely that the agent that resumed it is still finishing its own turn.
 */
let invokeWaitMs = 10 * 60_000;

/** Test hook: the real budget would make a lock-timeout case a 10-minute test. */
export function setAgentInvokeWaitMs(ms: number): number {
  const previous = invokeWaitMs;
  invokeWaitMs = ms;
  return previous;
}

/**
 * Chats with an invocation waiting for the lock. A second failure in the same
 * chat must not queue a second turn behind the first: the agent reads the
 * whole transcript, so one turn handles every failure posted to it, and two
 * would race for the same worktree.
 */
const pendingInvocations = new Set<string>();

/**
 * Run an agent turn in a chat off the automatism messages already appended
 * (a 'continue' turn — nothing else is added to the transcript). Waits for
 * the chat's turn lock in case the agent is mid-turn.
 */
async function invokeAgent(chatId: string, userId: string): Promise<void> {
  if (pendingInvocations.has(chatId)) {
    // The turn that is about to start reads the transcript this failure was
    // just appended to, so it handles this one too.
    console.log(`[automatism] chat=${chatId} agent invocation already pending — folding into it`);
    return;
  }
  pendingInvocations.add(chatId);
  try {
    await invokeAgentLocked(chatId, userId);
  } finally {
    pendingInvocations.delete(chatId);
  }
}

async function invokeAgentLocked(chatId: string, userId: string): Promise<void> {
  const start = Date.now();
  let lockId = acquireTurnLock(chatId);
  let lastLog = start;
  while (!lockId && Date.now() - start < invokeWaitMs) {
    await new Promise((r) => setTimeout(r, 2000));
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      console.log(
        `[automatism] chat=${chatId} still waiting for the turn lock (${Math.round((Date.now() - start) / 1000)}s)`,
      );
    }
    lockId = acquireTurnLock(chatId);
  }
  if (!lockId) {
    // Silence here would strand the flow: paused, nobody working on it, and
    // nothing on screen saying so. Say it in the chat and light up the error
    // banner, whose Retry runs exactly the turn this could not start.
    console.error(`[automatism] chat=${chatId} agent turn lock timeout — not invoking`);
    const message = tmsg('automatism.agentBusy');
    await postAutomatismMessage(chatId, message).catch((err: unknown) =>
      console.error('[automatism] could not post the busy notice:', err),
    );
    await prisma.chat
      .updateMany({ where: { id: chatId }, data: { lastError: message.fallback } })
      .catch(() => {});
    broadcast(chatId, 'error', { type: 'error', message: message.fallback });
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
  await reinvokeAbandonedRepairs();
}

/**
 * Paused automatisms whose repair turn never happened.
 *
 * Pausing and invoking the agent are two steps, and a process that dies
 * between them leaves the flow paused with its failure posted and nobody
 * acting on it — indistinguishable, from the outside, from an agent that is
 * thinking. The tell is the transcript: if the failure notice is still the
 * last message in the chat, no turn ever ran on it.
 */
async function reinvokeAbandonedRepairs(): Promise<void> {
  const paused = await prisma.automatism.findMany({ where: { status: 'paused' } });
  for (const row of paused) {
    const chatId = row.agentChatId ?? row.chatId;
    if (hasActiveTurn(chatId)) continue;
    const last = await prisma.message.findFirst({
      where: { chatId },
      orderBy: { ordinal: 'desc' },
      select: { role: true },
    });
    if (last?.role !== 'automatism') continue;
    const data = row.data as AutomatismData;
    if (!data?.actorId) continue;
    console.log(`[automatism] ${row.id} paused with no repair turn — invoking the agent`);
    void invokeAgent(chatId, data.actorId);
  }
}

/**
 * The repair a chat is currently on the hook for: the newest paused
 * automatism actionable from it, resolved to the failed step's tool set.
 * Null when nothing is paused, or when that step declares no tools of its own
 * (then the chat's phase decides, as before).
 */
export async function activeRepair(chatId: string): Promise<RepairContext | null> {
  const row = await findPausedAutomatism(chatId);
  if (!row) return null;
  const tools = repairToolsFor(row.type, row.step);
  if (!tools) return null;
  return {
    automatismId: row.id,
    type: row.type,
    step: row.step,
    stepName: types.get(row.type)?.steps[row.step]?.name ?? String(row.step),
    tools,
  };
}

/** Newest paused automatism actionable from `chatId` (home or agent chat). */
export async function findPausedAutomatism(chatId: string) {
  return prisma.automatism.findFirst({
    where: { status: 'paused', OR: [{ chatId }, { agentChatId: chatId }] },
    orderBy: { updatedAt: 'desc' },
  });
}
