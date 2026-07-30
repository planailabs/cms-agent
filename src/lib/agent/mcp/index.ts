/**
 * In-process MCP layer (plan §2). All CMS tools are registered on an
 * in-process McpServer connected over InMemoryTransport; the bridge converts
 * the MCP tool list to OpenAI function tools and routes tool calls back
 * through the MCP client. One pair per turn — the tool set depends on the
 * chat's workflow phase and the execution context is turn-scoped.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type OpenAI from 'openai';
import { z } from 'zod';
import { executeTool, isClientSideTool, toolsForPhase, type ToolContext } from '../tools/registry';
import { attachCodebaseMemory } from './codebaseMemory';
import { attachContext7 } from './context7';
import { attachCustomMcps } from './custom';
import { readOnlyView, type ExternalMcp } from './external';
import { mcpAccess, type McpAccess } from './policy';

/** In-process tools include image generation, builds and deploys — the SDK's
 *  60s default request timeout (-32001) kills them mid-run. */
const OWN_TOOL_TIMEOUT_MS = 600_000;

export interface McpBridge {
  /** OpenAI function-tool definitions for the current phase. */
  asOpenAiTools(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  /** System-prompt guidance lines for the external MCPs that actually attached. */
  promptHints(): string[];
  /** Dispatch a model tool call through MCP; returns the tool result string. */
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Apply an access decision to what a source actually attached: drop the
 * failures, narrow to read-only where required, and forget a server whose
 * tools were all filtered away — its prompt hint would advertise nothing.
 */
function applyAccess(attachments: Array<ExternalMcp | null>, access: McpAccess): ExternalMcp[] {
  return attachments
    .filter((e): e is ExternalMcp => e !== null)
    .map((e) => (access.readOnlyOnly ? readOnlyView(e) : e))
    .filter((e) => e.toolNames.size > 0);
}

export async function createMcpBridge(ctx: ToolContext): Promise<McpBridge> {
  const server = new McpServer({ name: 'cms-agent', version: '1.0.0' });

  for (const tool of toolsForPhase(ctx.workflowPhase, ctx.chatKind, ctx.deployFlowId, ctx.planMode)) {
    const shape =
      tool.schema instanceof z.ZodObject ? (tool.schema as z.AnyZodObject).shape : undefined;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape },
      async (args: Record<string, unknown>) => {
        // Client-side tools are intercepted by the tool loop before dispatch;
        // reaching this handler means a routing bug or a hallucinated call.
        const text = tool.execute
          ? await executeTool(tool.name, args ?? {}, ctx)
          : JSON.stringify({ error: `Tool "${tool.name}" is handled by the browser.` });
        return { content: [{ type: 'text' as const, text }] };
      },
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cms-agent-loop', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // External MCPs (sandboxed codebase graph, Context7 docs, custom servers
  // from the admin config + the branch's .mcp.json) — merged into the tool
  // set, but under the same phase boundary the in-process registry enforces:
  // policy.ts decides whether a source attaches at all and whether it is
  // reduced to its declared read-only tools. Order matters: on tool-name
  // collisions the earlier source wins (asOpenAiTools dedupes, callTool
  // matches first).
  const known = mcpAccess('known', { phase: ctx.workflowPhase, kind: ctx.chatKind });
  const custom = mcpAccess('custom', { phase: ctx.workflowPhase, kind: ctx.chatKind });
  const [knownAttachments, customAttachments] = await Promise.all([
    known.attach
      ? Promise.all([attachCodebaseMemory(ctx), attachContext7()])
      : Promise.resolve([]),
    custom.attach
      ? attachCustomMcps(
          ctx.worktreePath ? { worktreePath: ctx.worktreePath, chatId: ctx.chatId } : undefined,
        )
      : Promise.resolve([]),
  ]);
  const externals = [
    ...applyAccess(knownAttachments, known),
    ...applyAccess(customAttachments, custom),
  ];

  return {
    async asOpenAiTools() {
      const { tools } = await client.listTools();
      const own = tools.map((t) => {
        // Strip the $schema marker — some OpenAI-compatible backends reject
        // parameters carrying it and then expose the tool WITHOUT parameters.
        const { $schema: _drop, ...parameters } =
          (t.inputSchema as Record<string, unknown>) ?? {};
        return {
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description ?? '',
            parameters: Object.keys(parameters).length > 0 ? parameters : { type: 'object' },
          },
        };
      });
      // Dedupe colliding tool names across externals (e.g. the same server
      // name in the admin config and a branch .mcp.json) — first wins.
      const seen = new Set(own.map((t) => t.function.name));
      const extTools = externals
        .flatMap((e) => e.openAiTools)
        .filter((t) => (seen.has(t.function.name) ? false : (seen.add(t.function.name), true)));
      return [...own, ...extTools];
    },
    promptHints() {
      return externals.map((e) => e.promptHint);
    },
    async callTool(name, input) {
      const ext = externals.find((e) => e.toolNames.has(name));
      if (ext) return ext.callTool(name, input);
      try {
        const result = await client.callTool({ name, arguments: input }, undefined, {
          timeout: OWN_TOOL_TIMEOUT_MS,
        });
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        return content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n');
      } catch (err) {
        // Unknown/removed tool names (e.g. scratch_* from pre-.scratch chat
        // histories) must not abort the turn — return an error the model can
        // act on instead.
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          error: `Unknown or failed tool "${name}": ${msg}. Scratch files live in the .scratch/ directory — use write_file/read_file/list_dir on .scratch/ paths.`,
        });
      }
    },
    async close() {
      await Promise.allSettled([client.close(), server.close(), ...externals.map((e) => e.close())]);
    },
  };
}

export { isClientSideTool };
