/**
 * The tool boundary reaches external MCPs too.
 *
 * The gap this guards against: in-process tools are filtered by phase and
 * re-validated on call, but external MCPs were attached and dispatched
 * independently — so a mutating custom server could write to the repo during
 * the read-only PLAN phase. The sandbox contains host damage; it does not
 * know what PLAN means.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const { attachCustomMcps, attachCodebaseMemory, attachContext7 } = vi.hoisted(() => ({
  attachCustomMcps: vi.fn(),
  attachCodebaseMemory: vi.fn(),
  attachContext7: vi.fn(),
}));

vi.mock('@/lib/agent/mcp/custom', () => ({ attachCustomMcps }));
vi.mock('@/lib/agent/mcp/codebaseMemory', () => ({ attachCodebaseMemory }));
vi.mock('@/lib/agent/mcp/context7', () => ({ attachContext7 }));

import { createMcpBridge } from '@/lib/agent/mcp';
import { externalMcp, readOnlyView } from '@/lib/agent/mcp/external';
import { mcpAccess } from '@/lib/agent/mcp/policy';
import { registerTool, type ChatKind, type ToolContext } from '@/lib/agent/tools/registry';
import type { WorkflowPhase } from '@/lib/agent/types';
import { z } from 'zod';

/** An MCP server exposing one declared-read-only tool and one undeclared. */
const stubClient = () =>
  ({
    async listTools() {
      return {
        tools: [
          { name: 'search', description: 'Search.', annotations: { readOnlyHint: true } },
          { name: 'deploy', description: 'Deploy.', annotations: { readOnlyHint: false } },
          { name: 'mystery', description: 'Undeclared.' },
        ],
      };
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
  }) as unknown as Client;

const ctx = (phase: WorkflowPhase, kind: ChatKind = 'workflow'): ToolContext => ({
  chatId: 'mcp-policy',
  branchId: 'b1',
  branchName: 'draft',
  userId: 'u1',
  workflowPhase: phase,
  chatKind: kind,
  worktreePath: '/tmp/does-not-matter',
  userContext: new Map(),
  modifiedPaths: new Set(),
});

// One in-process tool so the MCP server advertises the tools capability.
registerTool({
  name: 'probe_tool',
  description: 'probe',
  schema: z.object({}),
  phases: ['plan', 'execute', 'published'],
  kinds: ['workflow', 'deployment', 'deployments'],
  execute: async () => 'ok',
});

const toolNames = async (c: ToolContext) => {
  const bridge = await createMcpBridge(c);
  try {
    return (await bridge.asOpenAiTools()).map((t) => t.function.name);
  } finally {
    await bridge.close();
  }
};

beforeEach(() => {
  attachCodebaseMemory.mockResolvedValue(null);
  attachContext7.mockResolvedValue(null);
  attachCustomMcps.mockReset();
  attachCustomMcps.mockImplementation(async () => [
    await externalMcp(stubClient(), (d) => d, 'custom hint'),
  ]);
});

describe('external MCP access policy', () => {
  it('offers custom servers from EXECUTE on', () => {
    expect(mcpAccess('custom', { phase: 'plan', kind: 'workflow' })).toEqual({
      attach: false,
      readOnlyOnly: false,
    });
    expect(mcpAccess('custom', { phase: 'execute', kind: 'workflow' })).toEqual({
      attach: true,
      readOnlyOnly: false,
    });
    // Nothing to change after publishing either.
    expect(mcpAccess('custom', { phase: 'published', kind: 'workflow' }).attach).toBe(false);
  });

  it('keeps the known integrations available in every phase', () => {
    for (const phase of ['plan', 'execute', 'published'] as WorkflowPhase[]) {
      expect(mcpAccess('known', { phase, kind: 'workflow' })).toEqual({
        attach: true,
        readOnlyOnly: false,
      });
    }
  });

  it('reduces every source to declared read-only tools in the deployment monitor', () => {
    for (const source of ['known', 'custom'] as const) {
      expect(mcpAccess(source, { phase: 'plan', kind: 'deployments' })).toEqual({
        attach: true,
        readOnlyOnly: true,
      });
    }
  });

  it('keeps a declared read-only tool and leaves an undeclared one out', async () => {
    const ext = await externalMcp(stubClient(), (d) => d, 'hint');
    expect(ext.readOnlyToolNames).toEqual(new Set(['search']));

    const restricted = readOnlyView(ext);
    expect([...restricted.toolNames]).toEqual(['search']);
    expect(restricted.openAiTools.map((t) => t.function.name)).toEqual(['search']);
  });

  it('never starts a custom server while the phase is read-only', async () => {
    expect(await toolNames(ctx('plan'))).toEqual(['probe_tool']);
    // Not merely filtered out of the list — the server is not spawned at all.
    expect(attachCustomMcps).not.toHaveBeenCalled();

    expect(await toolNames(ctx('execute'))).toEqual([
      'probe_tool',
      'search',
      'deploy',
      'mystery',
    ]);
    expect(attachCustomMcps).toHaveBeenCalledTimes(1);
  });

  it('gives the deployment monitor only the tools that declare read-only', async () => {
    expect(await toolNames(ctx('execute', 'deployments'))).toEqual(['probe_tool', 'search']);
  });

  it('drops a source whose tools were all filtered away, hint included', async () => {
    attachCustomMcps.mockImplementation(async () => [
      await externalMcp(
        {
          async listTools() {
            return { tools: [{ name: 'mutate', description: 'Undeclared.' }] };
          },
          async close() {},
        } as unknown as Client,
        (d) => d,
        'custom hint',
      ),
    ]);
    const bridge = await createMcpBridge(ctx('execute', 'deployments'));
    try {
      expect((await bridge.asOpenAiTools()).map((t) => t.function.name)).toEqual(['probe_tool']);
      // No tools left, so the prompt must not advertise the server either.
      expect(bridge.promptHints()).toEqual([]);
    } finally {
      await bridge.close();
    }
  });
});
