/**
 * The OpenAI tool definitions generated through the MCP bridge must carry the
 * real parameter schemas — an empty {type:'object'} makes the model call every
 * tool with {} (it cannot know any parameters exist).
 */
import { describe, expect, it } from 'vitest';
import { createMcpBridge } from '@/lib/agent/mcp';
import type { ToolContext } from '@/lib/agent/tools/registry';
import '@/lib/agent/handler'; // registers all tools

const ctx: ToolContext = {
  chatId: 'schema-chat',
  branchId: 'schema-branch',
  branchName: 'main',
  userId: 'schema-user',
  workflowPhase: 'execute',
  chatKind: 'workflow',
  worktreePath: '/tmp',
  userContext: new Map(),
  modifiedPaths: new Set(),
};

describe('mcp → openai tool schemas', () => {
  it('exposes real parameter schemas (properties + required)', async () => {
    const bridge = await createMcpBridge(ctx);
    try {
      const tools = await bridge.asOpenAiTools();
      const byName = Object.fromEntries(tools.map((t) => [t.function.name, t.function.parameters]));

      const writeFile = byName.write_file as { properties?: Record<string, unknown>; required?: string[] };
      expect(writeFile?.properties).toHaveProperty('path');
      expect(writeFile?.properties).toHaveProperty('content');
      expect(writeFile?.required).toContain('path');

      const editFile = byName.edit_file as { properties?: Record<string, unknown> };
      expect(editFile?.properties).toHaveProperty('oldText');

      const removeFile = byName.remove_file as { properties?: Record<string, unknown> };
      expect(removeFile?.properties).toHaveProperty('recursive');

      // Every tool with a non-empty zod object must expose properties
      const empty = tools.filter((t) => {
        const p = t.function.parameters as { properties?: Record<string, unknown> } | undefined;
        return !p?.properties || Object.keys(p.properties).length === 0;
      });
      // Tools with genuinely empty schemas (z.object({})) are fine.
      // list_projects is external (codebase-memory) — attached only when the
      // test runs with a sandbox; its empty schema is upstream's.
      const legitimatelyEmpty = new Set([
        'list_pages', 'git_status', 'git_branches', 'get_user_context', 'list_conflicts',
        'resume_automatism', 'git_rebase_continue', 'git_rebase_abort', 'scratch_list',
        'list_uploads', 'content_inventory', 'site_structure', 'list_projects',
      ]);
      const unexpected = empty.map((t) => t.function.name).filter((n) => !legitimatelyEmpty.has(n));
      expect(unexpected).toEqual([]);

      // $schema must be stripped (some backends drop parameters carrying it)
      expect(JSON.stringify(tools)).not.toContain('$schema');
    } finally {
      await bridge.close();
    }
  });
});
