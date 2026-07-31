/**
 * The capability router.
 *
 * It decides what the system prompt carries, so its failure mode matters more
 * than its success one: falling back to "list everything" would restore the
 * cost this feature removes and hide a broken router for as long as nobody
 * reads the logs. It therefore throws, and the turn fails visibly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create } };
  },
}));

import { resetRouterMemo, routeCapabilities } from '@/lib/agent/skillRouter';
import type { PluginSkill } from '@/lib/agent/plugins';
import type { McpGroupView } from '@/lib/agent/mcp/groups';
import type { StoredMessage } from '@/lib/agent/types';

const skill = (name: string): PluginSkill => ({
  plugin: 'test',
  name,
  description: `${name} skill`,
  body: '',
  dir: '/tmp',
  scripts: [],
});

const group = (id: string): McpGroupView => ({
  id,
  description: `${id} group`,
  source: 'config',
  servers: [id],
  loaded: false,
  isDefault: false,
});

const answer = (content: string, usage = { prompt_tokens: 10, completion_tokens: 2 }) => ({
  choices: [{ message: { content } }],
  usage,
});

const input = (messages: StoredMessage[] = [{ role: 'user', content: 'add a blog post' }]) => ({
  chatId: 'router-test',
  messages,
  skills: [skill('ui-verify'), skill('deploy-check')],
  groups: [group('search'), group('context7')],
  phase: 'plan' as const,
  kind: 'workflow' as const,
});

beforeEach(() => {
  create.mockReset();
  resetRouterMemo();
});

describe('capability router', () => {
  it('returns the picks the model made, with the tokens it spent', async () => {
    create.mockResolvedValueOnce(
      answer(JSON.stringify({ skills: ['ui-verify'], groups: ['context7'] })),
    );
    const verdict = await routeCapabilities(input());
    expect(verdict).toEqual({
      skills: ['ui-verify'],
      groups: ['context7'],
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it('drops names that are not in the index', async () => {
    // A hallucinated skill in the prompt would send the agent to use_skill for
    // something that does not exist.
    create.mockResolvedValueOnce(
      answer(JSON.stringify({ skills: ['ui-verify', 'imaginary'], groups: ['nope'] })),
    );
    const verdict = await routeCapabilities(input());
    expect(verdict.skills).toEqual(['ui-verify']);
    expect(verdict.groups).toEqual([]);
  });

  it('unwraps a fenced answer and matches names case-insensitively', async () => {
    create.mockResolvedValueOnce(
      answer('```json\n{"skills":["UI-Verify"],"groups":["Search"]}\n```'),
    );
    const verdict = await routeCapabilities(input());
    expect(verdict.skills).toEqual(['ui-verify']);
    expect(verdict.groups).toEqual(['search']);
  });

  it('re-asks once when the answer is not JSON', async () => {
    create
      .mockResolvedValueOnce(answer('Sure! Here are the skills you want.'))
      .mockResolvedValueOnce(answer(JSON.stringify({ skills: [], groups: ['search'] })));
    const verdict = await routeCapabilities(input());
    expect(create).toHaveBeenCalledTimes(2);
    expect(verdict.groups).toEqual(['search']);
    // Both attempts are paid for.
    expect(verdict.inputTokens).toBe(20);
  });

  it('throws instead of falling back when the answer never parses', async () => {
    create.mockResolvedValue(answer('still not json'));
    await expect(routeCapabilities(input())).rejects.toThrow(/no usable JSON/);
  });

  it('throws when the request itself fails', async () => {
    create.mockRejectedValue(new Error('router endpoint down'));
    await expect(routeCapabilities(input())).rejects.toThrow('router endpoint down');
  });

  it('routes a turn once, so a phase flip does not pay twice', async () => {
    create.mockResolvedValue(answer(JSON.stringify({ skills: ['deploy-check'], groups: [] })));
    const first = await routeCapabilities(input());
    const second = await routeCapabilities(input());

    expect(create).toHaveBeenCalledTimes(1);
    expect(second.skills).toEqual(first.skills);
    // The replay is free — charging the turn twice for one decision would be
    // an invented cost.
    expect(second.inputTokens).toBe(0);

    // A new message is a new decision.
    await routeCapabilities(
      input([
        { role: 'user', content: 'add a blog post' },
        { role: 'user', content: 'now deploy it' },
      ]),
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('sends the recent user text and both indexes to the router model', async () => {
    create.mockResolvedValueOnce(answer(JSON.stringify({ skills: [], groups: [] })));
    await routeCapabilities(input());
    const prompt = create.mock.calls[0][0].messages.at(-1).content as string;
    expect(prompt).toContain('ui-verify');
    expect(prompt).toContain('context7');
    expect(prompt).toContain('add a blog post');
  });
});
