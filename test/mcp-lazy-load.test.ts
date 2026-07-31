/**
 * Lazy MCP loading.
 *
 * The tool list a turn starts with is the phase defaults and nothing else: a
 * configured server the chat never asked for costs no prompt tokens, and is
 * not even started — which is the part a tool-name filter alone would not buy.
 * What follows pins both halves, plus the fact that loading does not open a
 * hole in the phase policy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

const { attachCustomMcpsLabeled, attachCodebaseMemory, attachContext7 } = vi.hoisted(() => ({
  attachCustomMcpsLabeled: vi.fn(),
  attachCodebaseMemory: vi.fn(),
  attachContext7: vi.fn(),
}));

vi.mock('@/lib/agent/mcp/custom', () => ({ attachCustomMcpsLabeled }));
vi.mock('@/lib/agent/mcp/codebaseMemory', () => ({ attachCodebaseMemory }));
vi.mock('@/lib/agent/mcp/context7', () => ({ attachContext7 }));

import { resetEnvCache } from '@/lib/env';
import { createMcpBridge } from '@/lib/agent/mcp';
import { externalMcp } from '@/lib/agent/mcp/external';
import { CODEBASE_MEMORY_GROUP } from '@/lib/agent/mcp/groups';
import { registerTool, type ChatKind, type ToolContext } from '@/lib/agent/tools/registry';
import type { WorkflowPhase } from '@/lib/agent/types';

/** A bridge serving two servers: one read-only tool each, plus a mutating one. */
const bridgeClient = () =>
  ({
    async listTools() {
      return {
        tools: [
          { name: 'mcp_brave_search', description: 'Search.', annotations: { readOnlyHint: true } },
          { name: 'mcp_exa_search', description: 'Search.', annotations: { readOnlyHint: true } },
          { name: 'mcp_exa_write', description: 'Write.' },
        ],
      };
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
  }) as unknown as Client;

const graph = () =>
  externalMcp(
    {
      async listTools() {
        return { tools: [{ name: 'search_graph', description: 'Graph.', annotations: { readOnlyHint: true } }] };
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      async close() {},
    } as unknown as Client,
    (d) => d,
    'graph hint',
  );

registerTool({
  name: 'lazy_probe_tool',
  description: 'probe',
  schema: z.object({}),
  phases: ['plan', 'execute', 'published'],
  kinds: ['workflow', 'deployment', 'deployments'],
  execute: async () => 'ok',
});

const ctx = (phase: WorkflowPhase = 'execute', kind: ChatKind = 'workflow'): ToolContext => ({
  chatId: 'lazy-load',
  branchId: 'b1',
  branchName: 'draft',
  userId: 'u1',
  workflowPhase: phase,
  chatKind: kind,
  worktreePath: '/tmp/does-not-matter',
  userContext: new Map(),
  modifiedPaths: new Set(),
});

const names = async (bridge: { asOpenAiTools: () => Promise<Array<{ function: { name: string } }>> }) =>
  (await bridge.asOpenAiTools()).map((t) => t.function.name);

const prevVarDir = process.env.VAR_DIR;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-lazy-'));
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        brave: { command: 'b', groups: ['search'] },
        exa: { command: 'e', groups: ['search'] },
      },
    }),
  );
  process.env.VAR_DIR = dir;
  resetEnvCache();
});
afterAll(() => {
  process.env.VAR_DIR = prevVarDir;
  resetEnvCache();
});

beforeEach(() => {
  attachContext7.mockReset().mockResolvedValue(null);
  attachCodebaseMemory.mockReset().mockImplementation(graph);
  attachCustomMcpsLabeled.mockReset();
  attachCustomMcpsLabeled.mockImplementation(async () => ({
    global: await externalMcp(bridgeClient(), (d) => d, 'custom hint'),
    worktree: null,
  }));
});

describe('lazy MCP loading', () => {
  it('starts with the defaults only, and never starts a server nobody asked for', async () => {
    const bridge = await createMcpBridge(ctx());
    try {
      expect(await names(bridge)).toEqual(['lazy_probe_tool', 'search_graph']);
      // The admin bridge would spawn a jail process and connect both servers.
      expect(attachCustomMcpsLabeled).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('adds a whole set of servers on load and reports what became callable', async () => {
    const c = ctx();
    const bridge = await createMcpBridge(c);
    try {
      const [result] = await bridge.control.load(['search']);
      expect(result).toEqual({
        id: 'search',
        tools: ['mcp_brave_search', 'mcp_exa_search', 'mcp_exa_write'],
      });
      expect(await names(bridge)).toEqual([
        'lazy_probe_tool',
        'search_graph',
        'mcp_brave_search',
        'mcp_exa_search',
        'mcp_exa_write',
      ]);
      // The bridge is asked only for the servers the loaded groups cover.
      expect(attachCustomMcpsLabeled.mock.calls[0][1]).toMatchObject({
        config: new Set(['brave', 'exa']),
      });
      expect(c.loadedMcpGroups?.has('search')).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it('loads one application out of a shared bridge without the others', async () => {
    const bridge = await createMcpBridge(ctx());
    try {
      const [result] = await bridge.control.load(['brave']);
      expect(result.tools).toEqual(['mcp_brave_search']);
      expect(await names(bridge)).not.toContain('mcp_exa_search');
    } finally {
      await bridge.close();
    }
  });

  it('keeps the phase policy: a group loaded while planning stays read-only', async () => {
    const bridge = await createMcpBridge(ctx('plan'));
    try {
      const [result] = await bridge.control.load(['search']);
      // mcp_exa_write declares nothing, so PLAN never sees it.
      expect(result.tools).toEqual(['mcp_brave_search', 'mcp_exa_search']);
    } finally {
      await bridge.close();
    }
  });

  it('names an unknown group instead of pretending it loaded', async () => {
    const bridge = await createMcpBridge(ctx());
    try {
      const [result] = await bridge.control.load(['nope']);
      expect(result.tools).toEqual([]);
      expect(result.error).toContain('Unknown MCP group "nope"');
    } finally {
      await bridge.close();
    }
  });

  it('drops a loaded group, and refuses to drop the ones the chat always has', async () => {
    const bridge = await createMcpBridge(ctx());
    try {
      await bridge.control.load(['search']);
      expect(bridge.control.unload(['search'])).toEqual({ dropped: ['search'], refused: [] });
      expect(await names(bridge)).toEqual(['lazy_probe_tool', 'search_graph']);

      expect(bridge.control.unload([CODEBASE_MEMORY_GROUP])).toEqual({
        dropped: [],
        refused: [CODEBASE_MEMORY_GROUP],
      });
      expect(await names(bridge)).toContain('search_graph');
    } finally {
      await bridge.close();
    }
  });

  it('refuses a call into an unloaded group with a message that says how to fix it', async () => {
    const bridge = await createMcpBridge(ctx());
    try {
      await bridge.control.load(['search']);
      bridge.control.unload(['search']);
      const result = await bridge.callTool('mcp_brave_search', {});
      expect(JSON.parse(result).error).toContain('load_mcp');
    } finally {
      await bridge.close();
    }
  });

  it('resumes from the groups an earlier turn loaded', async () => {
    const c = { ...ctx(), loadedMcpGroups: new Set(['search']) };
    const bridge = await createMcpBridge(c);
    try {
      expect(await names(bridge)).toContain('mcp_exa_search');
      // …with the defaults added back on top of what was persisted.
      expect(await names(bridge)).toContain('search_graph');
    } finally {
      await bridge.close();
    }
  });
});
