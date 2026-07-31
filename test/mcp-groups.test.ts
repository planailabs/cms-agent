/**
 * MCP groups — the unit a chat loads tools in.
 *
 * The index is derived from the same config files the servers are declared in,
 * so a group id is only ever as good as what the admin (or the branch repo)
 * wrote. These cases pin what that derivation promises: a server is always its
 * own group, a `groups` key joins several servers into a set, and a tool can be
 * traced back to its group through the bridge's name prefix.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import {
  CODEBASE_MEMORY_GROUP,
  CONTEXT7_GROUP,
  defaultGroups,
  groupIndex,
  groupViews,
  safeName,
  serverEntries,
  serversForGroups,
  toolBelongsTo,
} from '@/lib/agent/mcp/groups';

const prevVarDir = process.env.VAR_DIR;
const prevKey = process.env.CONTEXT7_API_KEY;
let dir = '';

const writeConfig = (file: string, servers: Record<string, unknown>): void =>
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-groups-'));
  process.env.VAR_DIR = dir;
  delete process.env.CONTEXT7_API_KEY;
  resetEnvCache();
});

afterAll(() => {
  process.env.VAR_DIR = prevVarDir;
  if (prevKey === undefined) delete process.env.CONTEXT7_API_KEY;
  else process.env.CONTEXT7_API_KEY = prevKey;
  resetEnvCache();
});

describe('MCP group index', () => {
  it('reads groups and descriptions without disturbing the standard config', () => {
    const file = path.join(dir, 'mcp.json');
    writeConfig(file, {
      brave: { command: 'brave-mcp', groups: ['search'], description: 'Web search' },
      exa: { command: 'exa-mcp', group: 'search' },
      notes: { url: 'https://notes.example/mcp' },
    });

    expect(serverEntries(file)).toEqual([
      { name: 'brave', groups: ['search'], description: 'Web search' },
      { name: 'exa', groups: ['search'], description: '' },
      { name: 'notes', groups: [], description: '' },
    ]);
    // The keys mcporter needs are untouched — our two are additive.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, { command?: string }> };
    expect(raw.mcpServers.brave.command).toBe('brave-mcp');
  });

  it('makes every server its own group and every declared set a shared one', () => {
    writeConfig(path.join(dir, 'mcp.json'), {
      brave: { command: 'b', groups: ['search'] },
      exa: { command: 'e', groups: ['search'] },
    });
    const index = groupIndex();

    expect(index.find((g) => g.id === 'brave')?.servers).toEqual(['brave']);
    expect(index.find((g) => g.id === 'exa')?.servers).toEqual(['exa']);
    expect(index.find((g) => g.id === 'search')?.servers).toEqual(['brave', 'exa']);
  });

  it('keeps the branch config separate from the admin one', () => {
    writeConfig(path.join(dir, 'mcp.json'), { brave: { command: 'b' } });
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-groups-wt-'));
    writeConfig(path.join(worktree, '.mcp.json'), { repotool: { command: 'r' } });

    const index = groupIndex(worktree);
    expect(index.find((g) => g.id === 'brave')?.source).toBe('config');
    expect(index.find((g) => g.id === 'repotool')?.source).toBe('worktree');
    // Only the branch's server belongs to the branch bridge.
    expect([...serversForGroups(['brave', 'repotool'], index, 'worktree')]).toEqual(['repotool']);
    expect([...serversForGroups(['brave', 'repotool'], index, 'config')]).toEqual(['brave']);
  });

  it('lists Context7 only when a key can actually attach it', () => {
    expect(groupIndex().some((g) => g.id === CONTEXT7_GROUP)).toBe(false);
    process.env.CONTEXT7_API_KEY = 'k';
    expect(groupIndex().some((g) => g.id === CONTEXT7_GROUP)).toBe(true);
  });

  it('refuses to let a config shadow a known group', () => {
    writeConfig(path.join(dir, 'mcp.json'), {
      impostor: { command: 'x', groups: [CODEBASE_MEMORY_GROUP] },
    });
    // The graph group stays the shipped integration, not the config's server.
    expect(groupIndex().find((g) => g.id === CODEBASE_MEMORY_GROUP)?.servers).toEqual([]);
  });

  it('starts a workflow chat on the codebase graph and the monitor on nothing', () => {
    expect(defaultGroups('workflow', 'plan')).toEqual([CODEBASE_MEMORY_GROUP]);
    expect(defaultGroups('deployment', 'execute')).toEqual([CODEBASE_MEMORY_GROUP]);
    expect(defaultGroups('deployments', 'published')).toEqual([]);
  });

  it('traces a bridged tool back to its server through the name prefix', () => {
    const servers = new Set(['brave', 'my server!']);
    expect(toolBelongsTo('mcp_brave_web_search', servers)).toBe(true);
    expect(toolBelongsTo(`mcp_${safeName('my server!')}_ask`, servers)).toBe(true);
    expect(toolBelongsTo('mcp_exa_search', servers)).toBe(false);
    // A CMS tool never belongs to an MCP group.
    expect(toolBelongsTo('read_file', servers)).toBe(false);
  });

  it('marks the loaded and the undroppable groups for the prompt', () => {
    writeConfig(path.join(dir, 'mcp.json'), { brave: { command: 'b' } });
    const views = groupViews(groupIndex(), new Set([CODEBASE_MEMORY_GROUP, 'brave']), [
      CODEBASE_MEMORY_GROUP,
    ]);
    expect(views.find((g) => g.id === CODEBASE_MEMORY_GROUP)).toMatchObject({
      loaded: true,
      isDefault: true,
    });
    expect(views.find((g) => g.id === 'brave')).toMatchObject({ loaded: true, isDefault: false });
  });
});
