/**
 * Stopping a running turn.
 *
 * The loop is not killed — it is asked to stop and ends itself at the next
 * boundary, which is what keeps the transcript usable afterwards: whatever the
 * model already said is kept, and every tool call it made still gets a result
 * row (an assistant tool_call without one is a conversation the next turn
 * cannot send to the model at all).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/lib/agent/tools/registry';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create } };
  },
}));

/** Tools the bridge actually executed, in order. */
const executed: string[] = [];
let onToolCall: (name: string) => void = () => {};

vi.mock('@/lib/agent/mcp', () => ({
  createMcpBridge: vi.fn(async (_ctx: ToolContext) => ({
    asOpenAiTools: async () => [
      { type: 'function' as const, function: { name: 'read_file', description: '', parameters: { type: 'object' } } },
    ],
    promptHints: () => [],
    callTool: async (name: string) => {
      executed.push(name);
      onToolCall(name);
      return JSON.stringify({ ok: true });
    },
    close: async () => {},
  })),
}));

import { acquireTurnLock, addConnection, releaseTurnLock, requestTurnStop } from '@/lib/agent/bus';
import { handleChatMessage } from '@/lib/agent/handler';

/** A stream whose chunks may run side effects — that is how a stop arrives
 *  mid-response in real life. `controller` is what the loop aborts. */
const stream = (chunks: Array<() => Record<string, unknown>>) => ({
  controller: { abort: () => aborted.push(true) },
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk();
  },
});
const aborted: boolean[] = [];

const text = (content: string) => () => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
const calls = (...names: string[]) => () => ({
  choices: [
    {
      delta: {
        tool_calls: names.map((name, index) => ({
          index,
          id: `call_${name}`,
          function: { name, arguments: '{}' },
        })),
      },
      finish_reason: 'tool_calls',
    },
  ],
});

/** Run one turn with the turn lock held, the way the endpoint does it. */
const run = async (chatId: string) => {
  const events: Array<{ event: string; data: unknown }> = [];
  const remove = addConnection(chatId, {
    write: (event, data) => events.push({ event, data }),
    end: () => {},
  });
  const lockId = acquireTurnLock(chatId)!;
  expect(lockId, 'the turn lock was already held').toBeTruthy();
  try {
    await handleChatMessage(
      'stop-user',
      'en',
      { chatId, type: 'message', text: 'Rewrite the whole site' },
      { skipPersistence: true, workflowPhase: 'execute' },
    );
  } finally {
    releaseTurnLock(chatId, lockId);
    remove();
  }
  return events;
};

beforeEach(() => {
  create.mockReset();
  executed.length = 0;
  aborted.length = 0;
  onToolCall = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stopping a turn', () => {
  it('ends mid-response, keeping what the model already said', async () => {
    const chatId = 'stop-streaming';
    create.mockResolvedValueOnce(
      stream([
        text('Rewriting the homepage'),
        () => {
          // The user hits Stop while the answer is still streaming.
          expect(requestTurnStop(chatId)).toBe(true);
          return text(' — and the about page')();
        },
      ]),
    );

    const events = await run(chatId);
    const names = events.map((e) => e.event);

    expect(names).toContain('stopped');
    expect(names[names.length - 1]).toBe('done');
    // The chunk that carried the stop is not part of the answer, and the
    // HTTP stream is closed rather than drained.
    const said = events.filter((e) => e.event === 'text_done').map((e) => (e.data as { content: string }).content);
    expect(said).toEqual(['Rewriting the homepage']);
    expect(aborted).toHaveLength(1);
    // No second round: the turn is over, not merely interrupted.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('runs no further tools, but answers every call it already made', async () => {
    const chatId = 'stop-tools';
    create.mockResolvedValue(stream([calls('read_file', 'read_file')]));
    onToolCall = () => {
      requestTurnStop(chatId);
    };

    const events = await run(chatId);

    // First call ran and set the stop; the second was never executed.
    expect(executed).toEqual(['read_file']);
    expect(create).toHaveBeenCalledTimes(1);
    const ends = events.filter((e) => e.event === 'tool_end');
    expect(ends).toHaveLength(1);
    expect(events.map((e) => e.event)).toContain('stopped');
  });

  it('does nothing on its own — the same script runs to the end untouched', async () => {
    const chatId = 'stop-control';
    create
      .mockResolvedValueOnce(stream([calls('read_file', 'read_file')]))
      .mockResolvedValueOnce(stream([text('Both files read.')]));

    const events = await run(chatId);

    expect(executed).toEqual(['read_file', 'read_file']);
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.event)).not.toContain('stopped');
    expect(aborted).toHaveLength(0);
  });

  it('is refused when the chat has no turn to stop', () => {
    expect(requestTurnStop('stop-idle-chat')).toBe(false);
  });

  it('does not leak into the next turn', async () => {
    const chatId = 'stop-leak';
    create.mockResolvedValueOnce(
      stream([
        () => {
          requestTurnStop(chatId);
          return text('cut short')();
        },
      ]),
    );
    await run(chatId);

    // The lock was released at the end of that turn, which clears the request.
    create.mockResolvedValueOnce(stream([text('Fresh answer.')]));
    const events = await run(chatId);
    expect(events.map((e) => e.event)).not.toContain('stopped');
  });
});
