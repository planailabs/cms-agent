/**
 * Shared agent-driving helpers for real-model scenarios (03-e2e, 06-recovery).
 *
 * Two ways out of PLAN, and both are driven here. By default the agent records
 * its plan with start_execution and implements it in the same turn, so a
 * journey needs no approval step at all. Sending the first message with the
 * /plan command switches the chat into explicit plan mode, where propose_plan
 * replaces start_execution and the turn stops for a human — that is the only
 * path that reaches approve-plan.
 */
import { expect } from 'vitest';
import { BenchClient, type SseEvent } from './client';
import { recordAssert } from './judge';

export interface ChatState {
  workflowPhase: string;
  turnPhase: string;
  /** Explicit plan mode — set by the /plan command. */
  planMode?: boolean;
  pendingQuestion: { toolName: string; input: Record<string, unknown> } | null;
  automatism: {
    status: string;
    automatismType: string;
    step: number;
    steps: string[];
    lastError: string | null;
  } | null;
}

export const chatState = async (client: BenchClient, chatId: string): Promise<ChatState> =>
  ((await client.get(`/api/chat/history?chatId=${chatId}`)).json as { state: ChatState }).state;

export const noError = (events: SseEvent[]): boolean => !events.some((e) => e.event === 'error');

/**
 * Drive a chat until the agent pauses on propose_plan, answering any
 * ask_question rounds along the way. Returns the plan input.
 *
 * The first message carries the /plan command: without it the agent has no
 * propose_plan tool at all — it would record a plan and start implementing.
 */
export async function driveToPlan(
  client: BenchClient,
  scenario: string,
  chatId: string,
  firstPrompt: string,
): Promise<Record<string, unknown>> {
  let text = `/plan ${firstPrompt}`;
  let type: 'message' | 'answer' = 'message';
  for (let round = 0; round < 4; round++) {
    const events = await client.sendMessageAndCollect(chatId, text, { type, timeoutMs: 420_000 });
    recordAssert(scenario, `turn ${round + 1} streams without error`, noError(events));
    expect(noError(events), `turn ${round + 1} errored`).toBe(true);
    const st = await chatState(client, chatId);
    if (st.turnPhase === 'waiting_for_answer' && st.pendingQuestion?.toolName === 'propose_plan') {
      return st.pendingQuestion.input;
    }
    if (st.turnPhase === 'waiting_for_answer') {
      text = 'No preferences — please proceed and propose the plan now.';
      type = 'answer';
    } else {
      text = '/plan Please propose the plan now using your propose_plan tool.';
      type = 'message';
    }
  }
  throw new Error('agent never proposed a plan');
}

/**
 * Drive a chat the default way: one message, and the agent plans and
 * implements without stopping. Answers ask_question rounds and returns once
 * the chat has reached EXECUTE (or gives up after a few rounds).
 */
export async function driveToExecution(
  client: BenchClient,
  scenario: string,
  chatId: string,
  firstPrompt: string,
): Promise<ChatState> {
  let text = firstPrompt;
  let type: 'message' | 'answer' = 'message';
  for (let round = 0; round < 4; round++) {
    const events = await client.sendMessageAndCollect(chatId, text, { type, timeoutMs: 600_000 });
    recordAssert(scenario, `turn ${round + 1} streams without error`, noError(events));
    expect(noError(events), `turn ${round + 1} errored`).toBe(true);
    const st = await chatState(client, chatId);
    // EXECUTE is the goal, whatever the turn ended on. A turn that reached it
    // usually ends PAUSED — on finish_execution ("ready for review"), or on a
    // question asked while implementing — and neither is a failure to get
    // there; the caller decides what to do with a pending card.
    if (st.workflowPhase === 'execute') return st;
    if (st.turnPhase === 'waiting_for_answer') {
      text = 'No preferences — go ahead and implement it.';
      type = 'answer';
    } else {
      text = 'Please go ahead and implement it now.';
      type = 'message';
    }
  }
  throw new Error('agent never reached the execute phase');
}

/** A fresh chat driven to committed work, the default (no-approval) way. */
export async function runToExecution(
  client: BenchClient,
  scenario: string,
  branchId: string,
  prompt: string,
): Promise<{ chatId: string; workBranch: string }> {
  const created = (await client.req('POST', '/api/chats', { branchId })).json as {
    chat: { id: string; workBranch: string };
  };
  await driveToExecution(client, scenario, created.chat.id, prompt);
  return { chatId: created.chat.id, workBranch: created.chat.workBranch };
}

/** Poll the chat's automatism state until it hits a terminal/paused status.
 *  Returns the last state plus whether 'paused' was ever observed. */
export async function waitForAutomatism(
  client: BenchClient,
  chatId: string,
  opts: { until: string[]; timeoutMs?: number; pollMs?: number; idleExit?: boolean } = {
    until: ['paused', 'succeeded', 'failed'],
  },
): Promise<{ status: string; pausedSeen: boolean; lastError: string | null }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 240_000);
  let pausedSeen = false;
  let turnSeen = false;
  let idleSince = 0;
  let last: ChatState['automatism'] = null;
  // The DB terminal-success status is 'done' (automatism.ts finishes with it)
  const norm = (s: string): string => (s === 'done' ? 'succeeded' : s);
  while (Date.now() < deadline) {
    const st = await chatState(client, chatId);
    last = st.automatism;
    if (last?.status === 'paused') pausedSeen = true;
    if (st.turnPhase !== 'idle') turnSeen = true;
    if (last && opts.until.includes(norm(last.status))) {
      return { status: norm(last.status), pausedSeen, lastError: last.lastError };
    }
    // Paused with no turn running = the failure-invoked agent finished
    // without resuming; nothing will change until someone resumes. The pause
    // and the agent turn starting are not atomic, so require that a turn was
    // actually observed (or a 60s idle stretch when it never started).
    if (opts.idleExit && last?.status === 'paused' && st.turnPhase === 'idle') {
      idleSince ||= Date.now();
      if (turnSeen || Date.now() - idleSince > 60_000) {
        return { status: 'paused', pausedSeen, lastError: last.lastError };
      }
    } else {
      idleSince = 0;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
  }
  return { status: norm(last?.status ?? 'absent'), pausedSeen, lastError: last?.lastError ?? null };
}

/** Poll a publication until it succeeds or fails. */
export async function waitForPublication(
  client: BenchClient,
  publicationId: string,
  timeoutMs = 300_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'queued';
  while (Date.now() < deadline) {
    const res = (await client.get(`/api/publications?id=${publicationId}`)).json as {
      publication?: { status: string };
    };
    status = res.publication?.status ?? status;
    if (status === 'succeeded' || status === 'failed') return status;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return status;
}
