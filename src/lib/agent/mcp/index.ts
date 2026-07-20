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
import type { ExternalMcp } from './external';

export interface McpBridge {
  /** OpenAI function-tool definitions for the current phase. */
  asOpenAiTools(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  /** System-prompt guidance lines for the external MCPs that actually attached. */
  promptHints(): string[];
  /** Dispatch a model tool call through MCP; returns the tool result string. */
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export async function createMcpBridge(ctx: ToolContext): Promise<McpBridge> {
  const server = new McpServer({ name: 'cms-agent', version: '1.0.0' });

  for (const tool of toolsForPhase(ctx.workflowPhase, ctx.chatKind, ctx.deployFlowId)) {
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

  // External MCPs (sandboxed codebase graph, Context7 docs, admin-configured
  // custom servers) — merged into the tool set
  const externals = (
    await Promise.all([attachCodebaseMemory(ctx), attachContext7(), attachCustomMcps()])
  )
    .flat()
    .filter((e): e is ExternalMcp => e !== null);

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
      return [...own, ...externals.flatMap((e) => e.openAiTools)];
    },
    promptHints() {
      return externals.map((e) => e.promptHint);
    },
    async callTool(name, input) {
      const ext = externals.find((e) => e.toolNames.has(name));
      if (ext) return ext.callTool(name, input);
      const result = await client.callTool({ name, arguments: input });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      return content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
    },
    async close() {
      await Promise.allSettled([client.close(), server.close(), ...externals.map((e) => e.close())]);
    },
  };
}

export { isClientSideTool };
