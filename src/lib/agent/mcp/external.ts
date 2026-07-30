/**
 * Shared shape for external MCP servers merged into the agent's tool set,
 * plus the client→OpenAI-tools wrapper both attachments use.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type OpenAI from 'openai';

export interface ExternalMcp {
  toolNames: Set<string>;
  openAiTools: OpenAI.Chat.Completions.ChatCompletionTool[];
  /** Tools that declare MCP's readOnlyHint annotation — see policy.ts. */
  readOnlyToolNames: Set<string>;
  /** One line of system-prompt guidance, added only while the server is attached. */
  promptHint: string;
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Narrow an attachment to the tools that declare themselves read-only. The
 * declaration is taken at face value; silence is not a declaration, so a tool
 * without the annotation disappears from both the model's tool list and the
 * dispatch table.
 */
export function readOnlyView(ext: ExternalMcp): ExternalMcp {
  const keep = ext.readOnlyToolNames;
  return {
    ...ext,
    toolNames: new Set([...ext.toolNames].filter((n) => keep.has(n))),
    openAiTools: ext.openAiTools.filter((t) => keep.has(t.function.name)),
  };
}

/** List the connected client's tools and wrap it as an ExternalMcp. */
export async function externalMcp(
  client: Client,
  annotate: (description: string) => string,
  promptHint: string,
): Promise<ExternalMcp> {
  const { tools } = await client.listTools();

  const openAiTools = tools.map((t) => {
    // Strip the $schema marker — some OpenAI-compatible backends reject
    // parameters carrying it and then expose the tool WITHOUT parameters.
    const { $schema: _drop, ...parameters } = (t.inputSchema as Record<string, unknown>) ?? {};
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: annotate(t.description ?? ''),
        parameters: Object.keys(parameters).length > 0 ? parameters : { type: 'object' },
      },
    };
  });

  return {
    toolNames: new Set(tools.map((t) => t.name)),
    openAiTools,
    readOnlyToolNames: new Set(
      tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
    ),
    promptHint,
    async callTool(name, input) {
      const result = await client.callTool({ name, arguments: input });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      return content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
