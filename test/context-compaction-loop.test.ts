import { beforeEach, describe, expect, it, vi } from 'vitest';

const { create } = vi.hoisted(() => ({
  create: vi.fn(async (input?: { stream?: boolean }) => {
    if (!input?.stream) {
      return {
        choices: [{ message: { content: 'Requirements and progress preserved.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 12 },
      };
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'Continued.' }, finish_reason: null }] };
        yield {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 3 },
        };
      },
    };
  }),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create } };
  },
}));

vi.mock('@/lib/agent/mcp', () => ({
  createMcpBridge: vi.fn(async () => ({
    asOpenAiTools: async () => [],
    control: {
      index: () => [],
      loaded: () => [],
      load: async () => [],
      unload: () => ({ dropped: [], refused: [] }),
    },
    promptHints: () => [],
    callTool: vi.fn(),
    close: vi.fn(),
  })),
}));

// The loop routes its capabilities before it prompts; that decision is not
// what these tests are about, and it must not consume a queued completion.
vi.mock('@/lib/agent/skillRouter', () => ({
  routeCapabilities: async () => ({ skills: [], groups: [], inputTokens: 0, outputTokens: 0 }),
}));


import { addConnection } from '@/lib/agent/bus';
import { runToolLoop } from '@/lib/agent/toolLoop';
import type { StoredMessage } from '@/lib/agent/types';

const run = async (
  messages: StoredMessage[],
  persisted: StoredMessage[],
  events: string[],
) => {
  const remove = addConnection('compact-loop', {
    write: (event) => events.push(event),
  });
  try {
    await runToolLoop({
      chatId: 'compact-loop',
      userId: 'u1',
      messages,
      phase: 'idle',
      toolContext: {
        chatId: 'compact-loop',
        branchId: 'b1',
        branchName: 'draft',
        targetBranchName: 'main',
        userId: 'u1',
        workflowPhase: 'execute',
        chatKind: 'workflow',
        worktreePath: '',
        userContext: new Map(),
        modifiedPaths: new Set(),
      },
      promptInput: {
        phase: 'execute',
        branchName: 'draft',
        locale: 'en',
        planJson: { summary: 'Approved work' },
      },
      setPhase: async () => {},
      appendMsg: async (message) => {
        messages.push(message);
        persisted.push(message);
      },
      skipTokenAccounting: true,
    });
  } finally {
    remove();
  }
};

describe('tool-loop context compaction', () => {
  beforeEach(() => create.mockClear());

  it('does not compact merely because the transcript exceeds a character heuristic', async () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'Original requirement' },
      { role: 'assistant', content: 'x'.repeat(66_000) },
    ];
    const persisted = messages.slice();
    const events: string[] = [];
    await run(messages, persisted, events);

    expect(create).toHaveBeenCalledTimes(1);
    expect(events).not.toContain('compaction_start');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('compacts only after the model reports its context limit, then retries', async () => {
    create.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Maximum context length exceeded'), {
        code: 'context_length_exceeded',
      });
    });
    const messages: StoredMessage[] = [
      { role: 'user', content: 'Original requirement' },
      { role: 'assistant', content: 'Earlier progress' },
    ];
    const persisted = messages.slice();
    const events: string[] = [];
    await run(messages, persisted, events);

    expect(create).toHaveBeenCalledTimes(3);
    expect(events.indexOf('compaction_start')).toBeLessThan(events.indexOf('compaction'));
    expect(events.indexOf('compaction')).toBeLessThan(events.lastIndexOf('thinking'));
    expect(events).toContain('done');
    expect(messages.map((m) => m.role)).toEqual(['compaction', 'assistant']);
    expect(persisted.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'compaction',
      'assistant',
    ]);
  });
});
