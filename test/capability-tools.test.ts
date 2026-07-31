/**
 * query_skills / query_mcps / load_mcp / unload_mcp, and the prompt section
 * they exist for.
 *
 * The prompt no longer lists every skill, so the way back to the rest has to
 * actually work — and it has to be visible, or the agent will conclude the
 * install has nothing else and invent its own approach.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { chat: { update } } }));

import { resetEnvCache } from '@/lib/env';
import { registerCapabilityTools } from '@/lib/agent/tools/capabilityTools';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';
import { pluginPromptSection, resetPluginCache } from '@/lib/agent/plugins';
import { buildSystemPrompt } from '@/lib/agent/prompt';
import type { McpControl, McpLoadResult } from '@/lib/agent/mcp';
import type { McpGroupView } from '@/lib/agent/mcp/groups';

registerCapabilityTools();

const view = (id: string, description: string, loaded = false): McpGroupView => ({
  id,
  description,
  source: 'config',
  servers: [id],
  loaded,
  isDefault: false,
});

const loaded = new Set(['codebase-memory']);
const control: McpControl = {
  index: () => [
    view('codebase-memory', 'Codebase graph of this branch.', true),
    view('context7', 'Up-to-date official library documentation.'),
    view('search', 'Web search servers.'),
  ],
  loaded: () => [...loaded],
  load: async (ids): Promise<McpLoadResult[]> => {
    for (const id of ids) loaded.add(id);
    return ids.map((id) => ({ id, tools: [`mcp_${id}_probe`] }));
  },
  unload: (ids) => {
    for (const id of ids) loaded.delete(id);
    return { dropped: ids, refused: [] };
  },
};

let worktree = '';
const ctx = (): ToolContext => ({
  chatId: 'cap-tools',
  branchId: 'b1',
  branchName: 'draft',
  userId: 'u1',
  workflowPhase: 'execute',
  chatKind: 'workflow',
  worktreePath: worktree,
  userContext: new Map(),
  modifiedPaths: new Set(),
  mcp: control,
});

const run = async (name: string, input: Record<string, unknown>) =>
  JSON.parse(await executeTool(name, input, ctx()));

const writeSkill = (name: string, description: string, body = ''): void => {
  const dir = path.join(worktree, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
};

const prevVarDir = process.env.VAR_DIR;
const prevPluginsRoot = process.env.CMS_PLUGINS_ROOT;
beforeAll(() => {
  process.env.VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-cap-var-'));
  // No marketplace here: the skills under test are the three below, not
  // whatever plugins the developer machine happens to have installed.
  process.env.CMS_PLUGINS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-cap-plugins-'));
  resetEnvCache();
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-cap-wt-'));
  writeSkill('publish-checklist', 'Steps to verify before publishing a page.');
  writeSkill('image-alt', 'Write alt text for images.', 'Describe what the photo shows.');
  writeSkill('translate-page', 'Translate a page into German.');
  resetPluginCache();
});
afterAll(() => {
  process.env.VAR_DIR = prevVarDir;
  if (prevPluginsRoot === undefined) delete process.env.CMS_PLUGINS_ROOT;
  else process.env.CMS_PLUGINS_ROOT = prevPluginsRoot;
  resetEnvCache();
  resetPluginCache();
});

beforeEach(() => {
  update.mockReset().mockResolvedValue({});
  loaded.clear();
  loaded.add('codebase-memory');
});

describe('capability tools', () => {
  it('finds a skill by a word from its description', async () => {
    const result = await run('query_skills', { query: 'publish' });
    expect(result.matches.map((m: { name: string }) => m.name)).toEqual(['publish-checklist']);
    expect(result.total).toBe(3);
  });

  it('ranks a name match above a body match', async () => {
    const result = await run('query_skills', { query: 'image photo' });
    expect(result.matches[0].name).toBe('image-alt');
  });

  it('lists what exists when nothing matches, so the agent stops guessing', async () => {
    const result = await run('query_skills', { query: 'kubernetes' });
    expect(result.matches).toEqual([]);
    expect(result.note).toContain('translate-page');
  });

  it('finds an MCP group by what it does, not just by its id', async () => {
    const result = await run('query_mcps', { query: 'documentation' });
    expect(result.groups.map((g: { id: string }) => g.id)).toEqual(['context7']);
    expect(result.loaded).toEqual(['codebase-memory']);
  });

  it('lists every group when asked without a query', async () => {
    const result = await run('query_mcps', {});
    expect(result.groups).toHaveLength(3);
  });

  it('loads a group, reports its tools and persists the state', async () => {
    const result = await run('load_mcp', { groups: ['search'] });
    expect(result.results).toEqual([{ id: 'search', tools: ['mcp_search_probe'] }]);
    expect(result.loaded).toEqual(['codebase-memory', 'search']);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'cap-tools' },
      data: { loadedMcpGroups: ['codebase-memory', 'search'] },
    });
  });

  it('says so when the state could not be saved instead of promising it', async () => {
    update.mockRejectedValue(new Error('db down'));
    const result = await run('load_mcp', { groups: ['search'] });
    expect(result.warning).toContain('db down');
  });

  it('drops a group and persists that too', async () => {
    await run('load_mcp', { groups: ['search'] });
    const result = await run('unload_mcp', { groups: ['search'] });
    expect(result.dropped).toEqual(['search']);
    expect(result.loaded).toEqual(['codebase-memory']);
  });
});

describe('the prompt these tools belong to', () => {
  it('lists only the routed skills, and says the others are searchable', () => {
    const section = pluginPromptSection(worktree, ['image-alt']);
    expect(section).toContain('image-alt');
    expect(section).not.toContain('translate-page');
    expect(section).toContain('query_skills');
  });

  it('still points at the index when the router picked nothing', () => {
    const section = pluginPromptSection(worktree, []);
    expect(section).toContain('query_skills');
    expect(section).toContain('3 are installed');
  });

  it('lists every skill when no routing happened at all', () => {
    const section = pluginPromptSection(worktree);
    expect(section).toContain('translate-page');
    expect(section).not.toContain('query_skills');
  });

  it('tells the agent which groups are loaded and how to get the rest', () => {
    const prompt = buildSystemPrompt({
      phase: 'execute',
      branchName: 'draft',
      locale: 'en',
      worktreePath: worktree,
      routedSkills: [],
      mcpGroups: control.index(),
      routedGroups: ['search'],
    });
    expect(prompt).toContain('codebase-memory — LOADED');
    expect(prompt).toContain('load_mcp');
    // The router's picks are candidates; nothing was loaded on its say-so.
    expect(prompt).toContain('not loaded yet: search');
    expect(prompt).not.toContain('search — LOADED');
  });
});
