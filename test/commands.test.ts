/**
 * Chat commands: the `/name` prefix that switches something on for a chat.
 *
 * The parser is deliberately strict. It runs on the server against whatever
 * text arrives, so anything it accepts silently rewrites what the user asked
 * for — an unknown slash-word, or a slash anywhere but the start, has to stay
 * ordinary text.
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS, activeFragment, findCommand, matchCommands, parseMessage } from '@/lib/commands';
import { toolsForPhase, type ToolContext } from '@/lib/agent/tools/registry';
import { registerClientTools } from '@/lib/agent/tools/clientTools';
import { registerChatTools } from '@/lib/agent/tools/chatTools';

registerClientTools();
registerChatTools();

describe('parsing a command off a message', () => {
  it('takes a known command at the start and strips it from the text', () => {
    expect(parseMessage('/plan make the footer bigger')).toEqual({
      command: COMMANDS.find((c) => c.name === 'plan'),
      text: 'make the footer bigger',
    });
    // Bare command, nothing else — still valid, still empties the text.
    expect(parseMessage('/plan').text).toBe('');
    expect(parseMessage('/PLAN redesign').command?.name).toBe('plan');
  });

  it('leaves anything it does not recognize completely alone', () => {
    for (const text of [
      '/unknown do the thing',
      'please read /plan.md and summarize it',
      'the file is at src/plan',
      '//plan',
      '/planning the release', // a longer word is not the command
      'plan the release',
    ]) {
      expect(parseMessage(text), text).toEqual({ command: null, text });
    }
  });
});

describe('autocomplete', () => {
  it('offers matches only while a slash-word is being typed at the start', () => {
    expect(activeFragment('/', 1)).toBe('');
    expect(activeFragment('/pl', 3)).toBe('pl');
    // Past the command, mid-sentence, or with the caret behind the word: closed.
    expect(activeFragment('/plan make it bigger', 20)).toBeNull();
    expect(activeFragment('read /plan', 10)).toBeNull();
    expect(activeFragment('/plan', 0)).toBeNull();
  });

  it('filters by prefix and every entry is a real command', () => {
    expect(matchCommands('').length).toBe(COMMANDS.length);
    expect(matchCommands('pl').map((c) => c.name)).toEqual(['plan']);
    expect(matchCommands('zzz')).toEqual([]);
    for (const c of COMMANDS) {
      expect(findCommand(c.name)).toBe(c);
      expect(c.description.length).toBeGreaterThan(0);
      expect(Object.keys(c.effect).length).toBeGreaterThan(0);
    }
  });
});

describe('/plan switches which planning tool exists', () => {
  const names = (planMode: boolean) =>
    toolsForPhase('plan', 'workflow', undefined, planMode).map((t) => t.name);

  it('offers propose_plan instead of start_execution, and never both', () => {
    expect(names(true)).toContain('propose_plan');
    expect(names(true)).not.toContain('start_execution');

    expect(names(false)).toContain('start_execution');
    expect(names(false)).not.toContain('propose_plan');
  });

  it('rejects the wrong one on call, not just in the listing', async () => {
    const { executeTool } = await import('@/lib/agent/tools/registry');
    const ctx = (planMode: boolean): ToolContext => ({
      chatId: 'cmd-gate',
      branchId: 'b',
      branchName: 'c-cmd',
      userId: 'u',
      workflowPhase: 'plan',
      chatKind: 'workflow',
      worktreePath: '',
      planMode,
      userContext: new Map(),
      modifiedPaths: new Set(),
    });
    // Hiding is not enforcement — a hallucinated call has to fail as data.
    const inPlanMode = JSON.parse(await executeTool('start_execution', {}, ctx(true)));
    expect(inPlanMode.error).toMatch(/plan mode/i);
  });
});
