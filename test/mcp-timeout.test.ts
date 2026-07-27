/**
 * In-process tool calls must survive past the MCP SDK's 60s default request
 * timeout — generate_image / builds / deploys regularly run longer and were
 * aborted with "MCP error -32001: Request timed out".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMcpBridge } from '@/lib/agent/mcp';
import { registerTool, type ToolContext } from '@/lib/agent/tools/registry';

const ctx: ToolContext = {
  chatId: 'timeout-chat',
  branchId: 'timeout-branch',
  branchName: 'main',
  userId: 'timeout-user',
  workflowPhase: 'execute',
  chatKind: 'workflow',
  worktreePath: '/tmp',
  userContext: new Map(),
  modifiedPaths: new Set(),
};

registerTool({
  name: 'slow_test_tool',
  description: 'test-only: resolves after 90s',
  schema: z.object({}),
  phases: ['execute'],
  async execute() {
    await new Promise((resolve) => setTimeout(resolve, 90_000));
    return 'slow-done';
  },
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('mcp bridge tool timeout', () => {
  it('a 90s tool call outlives the SDK 60s default', async () => {
    const bridge = await createMcpBridge(ctx);
    try {
      const pending = bridge.callTool('slow_test_tool', {});
      await vi.advanceTimersByTimeAsync(91_000);
      expect(await pending).toBe('slow-done');
    } finally {
      await bridge.close();
    }
  });
});
