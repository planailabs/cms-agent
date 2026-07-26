/**
 * Shared agent-driving helpers for real-model scenarios (03-e2e, 06-recovery):
 * drive a chat to a proposed plan, run an approved execution, and poll the
 * automatism / publication state the server exposes.
 */
import { expect } from 'vitest';
import { BenchClient, type SseEvent } from './client';
import { recordAssert } from './judge';

export interface ChatState {
  workflowPhase: string;
  turnPhase: string;
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

/** Drive a chat until the agent pauses on propose_plan (answering any
 *  ask_question rounds along the way). Returns the plan input. */
export async function driveToPlan(
  client: BenchClient,
  scenario: string,
  chatId: string,
  firstPrompt: string,
): Promise<Record<string, unknown>> {
  let text = firstPrompt;
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
      text = 'Please propose the plan now using your propose_plan tool.';
      type = 'message';
    }
  }
  throw new Error('agent never proposed a plan');
}

/** Full plan→approve→execute on a fresh chat; returns its ids once the
 *  execution turn has finished (finish card pending or idle). */
export async function runToExecution(
  client: BenchClient,
  scenario: string,
  branchId: string,
  prompt: string,
): Promise<{ chatId: string; workBranch: string }> {
  const created = (await client.req('POST', '/api/chats', { branchId })).json as {
    chat: { id: string; workBranch: string };
  };
  const chatId = created.chat.id;
  await driveToPlan(client, scenario, chatId, prompt);
  const events = await client.collectEvents(
    chatId,
    async () => {
      const res = await client.req('POST', `/api/chats/${chatId}/approve-plan`, {});
      if (res.status !== 200) throw new Error(`approve-plan: ${res.status} ${res.text}`);
    },
    ['question', 'done', 'error'],
    600_000,
  );
  recordAssert(scenario, 'execution turn streams without error', noError(events));
  expect(noError(events), 'execution errored').toBe(true);
  return { chatId, workBranch: created.chat.workBranch };
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
