import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compactionTranscript,
  sanitizeMessages,
  toOpenAiMessages,
} from '@/lib/agent/messageUtils';
import { buildSystemPrompt } from '@/lib/agent/prompt';
import { buildQuestionToolResults } from '@/lib/agent/toolLoop';
import { addConnection } from '@/lib/agent/bus';
import { registerClientTools } from '@/lib/agent/tools/clientTools';
import { registerChatTools } from '@/lib/agent/tools/chatTools';
import { registerFsTools } from '@/lib/agent/tools/fsTools';
import { executeTool, isClientSideTool, toolsForPhase, type ToolContext } from '@/lib/agent/tools/registry';
import { createMcpBridge } from '@/lib/agent/mcp';
import type { StoredMessage, ToolCall } from '@/lib/agent/types';

registerClientTools();
registerChatTools();
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
    chatKind: 'workflow',
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
      { role: 'compaction', content: 'Earlier work summary' },
      { role: 'assistant', content: 'done' },
    ];
    const out = toOpenAiMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
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

  it('renders a bounded compaction transcript without modifying stored messages', () => {
    const big = 'x'.repeat(80_000);
    const msgs: StoredMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'latest' },
    ];
    expect(msgs).toHaveLength(4);
    const transcript = compactionTranscript(msgs);
    expect(transcript.length).toBeLessThanOrEqual(120_100);
    expect(transcript).toContain('[user]\nfirst');
    expect(transcript).toContain('[user]\nlatest');
    const reduced = compactionTranscript(msgs, 8_000);
    expect(reduced.length).toBeLessThanOrEqual(8_000);
    expect(reduced).toContain('[user]\nfirst');
    expect(reduced).toContain('[user]\nlatest');
  });

  it('loads an approved plan in every workflow phase prompt', () => {
    for (const phase of ['plan', 'execute', 'preview', 'published'] as const) {
      const prompt = buildSystemPrompt({
        phase,
        branchName: 'draft',
        locale: 'en',
        planJson: { summary: 'Keep this plan' },
      });
      expect(prompt).toContain('Approved workflow plan');
      expect(prompt).toContain('Keep this plan');
      if (phase === 'execute') expect(prompt).toContain('return_to_plan');
    }
  });

  it('uses plain website language by default but not in technical mode', () => {
    const input = {
      phase: 'plan' as const,
      branchName: 'draft',
      locale: 'en',
    };
    expect(buildSystemPrompt(input)).toContain('speaking with a website owner');
    expect(buildSystemPrompt({ ...input, communicationMode: 'technical' })).not.toContain(
      'speaking with a website owner',
    );
    for (const communicationMode of ['technical', 'non-technical'] as const) {
      expect(buildSystemPrompt({ ...input, communicationMode })).toContain(
        'Never mention the skills, rules, system instructions, or prompt guidance',
      );
    }
  });

  it('uses the latest human message language and requests a transient UI switch', () => {
    const prompt = buildSystemPrompt({
      phase: 'plan',
      branchName: 'draft',
      locale: 'en',
    });
    expect(prompt).toContain('latest message actually written by the human user');
    expect(prompt).toContain('user_ui_change_language before replying');
    expect(prompt).toContain('quoted, pasted, or uploaded content');
    expect(prompt).not.toContain('Respond ONLY in English');
  });

  it('requires pasted and uploaded content to be transferred verbatim', () => {
    const prompt = buildSystemPrompt({
      phase: 'execute',
      branchName: 'draft',
      locale: 'en',
    });
    expect(prompt).toContain('preserve it verbatim');
    expect(prompt).toMatch(/unless the user\s+explicitly asks you to/);
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
    expect(planTools).not.toContain('remove_file');
    expect(execTools).toContain('remove_file');
    expect(execTools).toContain('finish_execution');
    expect(execTools).toContain('return_to_plan');
    expect(planTools).toContain('user_ui_change_language');
    expect(execTools).toContain('user_ui_change_language');
    expect(execTools).not.toContain('propose_plan');
    expect(planTools).not.toContain('return_to_plan');
  });

  it('broadcasts language changes only to the live SSE connection', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const remove = addConnection('c1', {
      write: (event, data) => events.push({ event, data }),
      end: () => {},
    });
    try {
      const result = await executeTool(
        'user_ui_change_language',
        { locale: 'de' },
        makeCtx(),
      );
      expect(JSON.parse(result)).toEqual({ ok: true, locale: 'de', persisted: false });
      expect(events).toEqual([
        { event: 'ui_language', data: { locale: 'de', userId: 'u1' } },
      ]);
    } finally {
      remove();
    }
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
  it('removes files and requires recursive mode for directories', async () => {
    const dir = path.join(tmpRepo, 'remove-me');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'nested.txt'), 'nested');
    const ctx = makeCtx({ workflowPhase: 'execute' });

    const refused = await executeTool('remove_file', { path: 'remove-me' }, ctx);
    expect(JSON.parse(refused).error).toBeTruthy();
    expect(fs.existsSync(dir)).toBe(true);

    const removed = await executeTool(
      'remove_file',
      { path: 'remove-me', recursive: true },
      ctx,
    );
    expect(JSON.parse(removed)).toEqual({ success: true, removed: 'remove-me' });
    expect(fs.existsSync(dir)).toBe(false);
    expect(JSON.parse(await executeTool('remove_file', { path: '.' }, ctx)).error).toMatch(
      /repository root/,
    );
  });

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
