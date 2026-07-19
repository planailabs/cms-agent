/**
 * External MCP attachments — the shared client wrapper and the Context7
 * token gate. The real Context7 endpoint is never contacted here.
 */
import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { externalMcp } from '@/lib/agent/mcp/external';
import { attachContext7 } from '@/lib/agent/mcp/context7';

const stubClient = (calls: string[]) =>
  ({
    async listTools() {
      return {
        tools: [
          {
            name: 'query-docs',
            description: 'Query docs.',
            inputSchema: { $schema: 'x', type: 'object', properties: { q: { type: 'string' } } },
          },
          { name: 'bare', description: undefined, inputSchema: undefined },
        ],
      };
    },
    async callTool({ name }: { name: string }) {
      calls.push(name);
      return { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] };
    },
    async close() {
      calls.push('close');
    },
  }) as unknown as Client;

describe('external MCP', () => {
  it('wraps a client: annotated tools, $schema stripped, text-joined results', async () => {
    const calls: string[] = [];
    const ext = await externalMcp(stubClient(calls), (d) => `${d} (annotated)`, 'Use for docs.');

    expect(ext.toolNames).toEqual(new Set(['query-docs', 'bare']));
    expect(ext.promptHint).toBe('Use for docs.');
    const [docs, bare] = ext.openAiTools;
    expect(docs.function.description).toBe('Query docs. (annotated)');
    expect(docs.function.parameters).not.toHaveProperty('$schema');
    expect(docs.function.parameters).toHaveProperty('properties');
    expect(bare.function.parameters).toEqual({ type: 'object' });

    expect(await ext.callTool('query-docs', { q: 'astro' })).toBe('a\nb');
    await ext.close();
    expect(calls).toEqual(['query-docs', 'close']);
  });

  it('attachContext7 is a no-op without a token', async () => {
    const prev = process.env.CONTEXT7_API_KEY;
    delete process.env.CONTEXT7_API_KEY;
    try {
      expect(await attachContext7()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.CONTEXT7_API_KEY = prev;
    }
  });
});
