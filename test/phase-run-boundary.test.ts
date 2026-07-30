/**
 * A workflow-phase change is a run boundary.
 *
 * The bug this guards against: the system prompt and the tool set are built
 * ONCE, before the loop. start_execution only flipped ctx.workflowPhase, so
 * the rest of the turn ran under the PLAN contract — the model kept being
 * told it was in the read-only PLAN phase and was still offered PLAN tools,
 * while the prompt promised it could implement immediately. Now the run ends
 * and the handler starts a fresh one whose prompt and tools match the new
 * phase; nothing is broadcast in between, so the user sees one turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { ToolContext } from '@/lib/agent/tools/registry';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create } };
  },
}));

/** Phase each bridge was built for, in order — one entry per run. */
const bridgePhases: string[] = [];
/** Tool the mocked bridge calls to move the workflow, set per test. */
let onToolCall: (name: string, ctx: ToolContext) => void = () => {};

vi.mock('@/lib/agent/mcp', () => ({
  createMcpBridge: vi.fn(async (ctx: ToolContext) => {
    bridgePhases.push(ctx.workflowPhase);
    // The real bridge lists the tools of the phase it was built for; that
    // snapshot is exactly what goes stale when the phase moves mid-run.
    const phaseTools = ctx.workflowPhase === 'plan' ? ['read_file'] : ['write_file'];
    return {
      asOpenAiTools: async () =>
        phaseTools.map((name) => ({
          type: 'function' as const,
          function: { name, description: '', parameters: { type: 'object' } },
        })),
      promptHints: () => [],
      callTool: async (name: string) => {
        onToolCall(name, ctx);
        return JSON.stringify({ ok: true });
      },
      close: async () => {},
    };
  }),
}));

import { addConnection } from '@/lib/agent/bus';
import { handleChatMessage } from '@/lib/agent/handler';

const toolCallChunk = (name: string) => ({
  async *[Symbol.asyncIterator]() {
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: `call_${name}`, function: { name, arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
  },
});

const textChunk = (text: string) => ({
  async *[Symbol.asyncIterator]() {
    yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
  },
});

/** System prompt and tool names the model actually received, per request. */
const request = (i: number) => {
  const body = create.mock.calls[i][0] as OpenAI.Chat.Completions.ChatCompletionCreateParams;
  return {
    system: String(body.messages[0].content),
    tools: (body.tools ?? []).map((t) => t.function.name),
  };
};

const run = async (chatId: string) => {
  const events: string[] = [];
  const remove = addConnection(chatId, { write: (event) => events.push(event), end: () => {} });
  try {
    await handleChatMessage(
      'phase-user',
      'en',
      { chatId, type: 'message', text: 'Fix the footer year' },
      { skipPersistence: true, workflowPhase: 'plan' },
    );
  } finally {
    remove();
  }
  return events;
};

beforeEach(() => {
  create.mockReset();
  bridgePhases.length = 0;
  onToolCall = () => {};
});

describe('workflow-phase run boundary', () => {
  it('restarts the run with the EXECUTE prompt and tools after start_execution', async () => {
    onToolCall = (name, ctx) => {
      if (name === 'start_execution') ctx.workflowPhase = 'execute';
    };
    create
      .mockResolvedValueOnce(toolCallChunk('start_execution'))
      .mockResolvedValueOnce(textChunk('Done — the footer shows 2026.'));

    const events = await run('phase-boundary-1');

    expect(create).toHaveBeenCalledTimes(2);
    // Run 1 planned under the PLAN contract...
    expect(request(0).system).toContain('PLAN phase');
    expect(request(0).tools).toEqual(['read_file']);
    // ...run 2 implements under the EXECUTE one. Before the fix this second
    // request never happened: the turn continued with the PLAN prompt.
    expect(request(1).system).toContain('EXECUTE phase');
    expect(request(1).tools).toEqual(['write_file']);
    expect(bridgePhases).toEqual(['plan', 'execute']);

    // Seamless for the user: one turn, one completion event at the very end.
    expect(events.filter((e) => e === 'done')).toHaveLength(1);
    expect(events[events.length - 1]).toBe('done');
  });

  it('returns to the PLAN contract when the agent calls return_to_plan', async () => {
    onToolCall = (name, ctx) => {
      if (name === 'return_to_plan') ctx.workflowPhase = 'plan';
    };
    create
      .mockResolvedValueOnce(toolCallChunk('return_to_plan'))
      .mockResolvedValueOnce(textChunk('The plan needs a rethink: ...'));

    await handleChatMessage(
      'phase-user',
      'en',
      { chatId: 'phase-boundary-2', type: 'message', text: 'Go ahead' },
      { skipPersistence: true, workflowPhase: 'execute' },
    );

    expect(bridgePhases).toEqual(['execute', 'plan']);
    expect(request(1).system).toContain('PLAN phase');
    expect(request(1).tools).toEqual(['read_file']);
  });

  it('stops granting runs when the agent ping-pongs between phases', async () => {
    onToolCall = (_name, ctx) => {
      ctx.workflowPhase = ctx.workflowPhase === 'plan' ? 'execute' : 'plan';
    };
    create.mockResolvedValue(toolCallChunk('start_execution'));

    const events = await run('phase-boundary-3');

    // Bounded, and the turn still ends cleanly instead of spinning.
    expect(create.mock.calls.length).toBe(4);
    expect(bridgePhases).toEqual(['plan', 'execute', 'plan', 'execute']);
    expect(events[events.length - 1]).toBe('done');
  });
});
