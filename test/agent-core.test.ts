import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sanitizeMessages, toOpenAiMessages, trimMessages } from '@/lib/agent/messageUtils';
import { buildQuestionToolResults } from '@/lib/agent/toolLoop';
import { registerClientTools } from '@/lib/agent/tools/clientTools';
import { registerFsTools } from '@/lib/agent/tools/fsTools';
import { executeTool, isClientSideTool, toolsForPhase, type ToolContext } from '@/lib/agent/tools/registry';
import { createMcpBridge } from '@/lib/agent/mcp';
import type { StoredMessage, ToolCall } from '@/lib/agent/types';

registerClientTools();
registerFsTools();

const call = (id: string, name: string, args: object = {}): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    chatId: 'c1',
    branchId: 'b1',
    branchName: 'test',
    userId: 'u1',
    workflowPhase: 'plan',
    worktreePath: tmpRepo,
    userContext: new Map(),
    modifiedPaths: new Set(),
    ...overrides,
  };
}

let tmpRepo: string;

beforeAll(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-agent-test-'));
  fs.mkdirSync(path.join(tmpRepo, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, 'src', 'pages', 'index.astro'), '<h1>Hello</h1>\n');
});

describe('message conversion', () => {
  it('converts stored messages to OpenAI shape, expanding tool batches', () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'looking', toolCalls: [call('t1', 'read_file', { path: 'x' })] },
      { role: 'tool', results: [{ toolCallId: 't1', content: 'data' }] },
      { role: 'cancel', content: 'cancelled' },
      { role: 'assistant', content: 'done' },
    ];
    const out = toOpenAiMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect((out[1] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    expect((out[2] as { tool_call_id: string }).tool_call_id).toBe('t1');
  });

  it('prepends page context to user messages', () => {
    const out = toOpenAiMessages([
      {
        role: 'user',
        content: 'fix this heading',
        pageContext: { url: 'https://draft.example.com/about/', selection: { exact: 'Abuot us' } },
      },
    ]);
    expect(out[0].content).toContain('[User context]');
    expect(out[0].content).toContain('Abuot us');
    expect(out[0].content).toContain('fix this heading');
  });

  it('sanitize drops assistant tool_calls without results and their orphans', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'text', tool_calls: [call('t1', 'read_file')] },
      { role: 'user', content: 'interrupted' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'text' },
      { role: 'user', content: 'interrupted' },
    ]);
  });

  it('trim keeps the first message and the newest tail within budget', () => {
    const big = 'x'.repeat(40_000);
    const msgs: StoredMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'latest' },
    ];
    const out = trimMessages(msgs);
    expect(out[0]).toEqual({ role: 'user', content: 'first' });
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'latest' });
    expect(out.length).toBeLessThan(msgs.length);
  });
});

describe('question tool results', () => {
  it('answers the client call and marks parallel calls skipped', () => {
    const calls = [call('a', 'ask_question'), call('b', 'read_file')];
    const results = buildQuestionToolResults(calls, 'a', 'Tuesday', false);
    expect(results[0].content).toContain('Tuesday');
    expect(results[1].content).toContain('Skipped');
  });
});

describe('phase gating', () => {
  it('exposes write tools only in execute phase', () => {
    const planTools = toolsForPhase('plan').map((t) => t.name);
    const execTools = toolsForPhase('execute').map((t) => t.name);
    expect(planTools).toContain('read_file');
    expect(planTools).toContain('propose_plan');
    expect(planTools).not.toContain('write_file');
    expect(execTools).toContain('write_file');
    expect(execTools).toContain('finish_execution');
    expect(execTools).not.toContain('propose_plan');
  });

  it('rejects a write tool executed during plan phase', async () => {
    const res = await executeTool('write_file', { path: 'x.md', content: 'y' }, makeCtx());
    expect(JSON.parse(res).error).toMatch(/not allowed in the plan phase/);
  });

  it('identifies client-side tools', () => {
    expect(isClientSideTool('ask_question')).toBe(true);
    expect(isClientSideTool('propose_plan')).toBe(true);
    expect(isClientSideTool('read_file')).toBe(false);
  });
});

describe('path jail', () => {
  it('reads inside the worktree and rejects escapes', async () => {
    const ok = await executeTool('read_file', { path: 'src/pages/index.astro' }, makeCtx());
    expect(ok).toContain('Hello');

    const escape = await executeTool('read_file', { path: '../../etc/passwd' }, makeCtx());
    expect(JSON.parse(escape).error).toMatch(/escapes the repository/);

    const abs = await executeTool('read_file', { path: '/etc/passwd' }, makeCtx());
    expect(JSON.parse(abs).error).toMatch(/escapes|ENOENT/);
  });

  it('rejects symlink escapes', async () => {
    fs.symlinkSync(os.tmpdir(), path.join(tmpRepo, 'sneaky'), 'dir');
    const res = await executeTool('read_file', { path: 'sneaky/whatever.txt' }, makeCtx());
    expect(JSON.parse(res).error).toMatch(/escapes the repository/);
  });
});

describe('mcp bridge', () => {
  it('lists phase tools as OpenAI tools and round-trips a call', async () => {
    const bridge = await createMcpBridge(makeCtx());
    const tools = await bridge.asOpenAiTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('ask_question');
    expect(names).not.toContain('write_file');
    expect(tools.find((t) => t.function.name === 'read_file')?.function.parameters).toHaveProperty(
      'properties',
    );

    const result = await bridge.callTool('read_file', { path: 'src/pages/index.astro' });
    expect(result).toContain('Hello');
    await bridge.close();
  });
});
