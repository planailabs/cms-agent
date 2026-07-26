/**
 * Context7 attachment — the hosted documentation MCP (mcp.context7.com,
 * streamable HTTP), merged into the agent's tool set when a CONTEXT7_API_KEY
 * is configured. Gives the agent up-to-date library docs (Astro, Tailwind, …)
 * instead of relying on training data.
 *
 * Fails soft: no key → simply not attached; connect error → warned once and
 * the agent works without docs tools.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { externalMcp, type ExternalMcp } from './external';

const MCP_URL = 'https://mcp.context7.com/mcp';

let warned = false;
const warnOnce = (msg: string): void => {
  if (!warned) console.warn(`[context7] ${msg} — docs tools disabled`);
  warned = true;
};

// One shared connection across turns (globalThis: survive Vite HMR reloads in
// dev) — the hosted tool list never changes mid-process, so reconnecting and
// re-listing on every turn only added network round-trips to turn start.
const g = globalThis as unknown as {
  __context7?: { key: string; attachment: Promise<ExternalMcp | null> } | null;
};

export async function attachContext7(): Promise<ExternalMcp | null> {
  // Read directly (not via env()) so partially-configured test envs stay quiet
  const apiKey = process.env.CONTEXT7_API_KEY;
  if (!apiKey) return null;
  if (g.__context7?.key === apiKey) return g.__context7.attachment;
  g.__context7 = { key: apiKey, attachment: connect(apiKey) };
  return g.__context7.attachment;
}

async function connect(apiKey: string): Promise<ExternalMcp | null> {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { CONTEXT7_API_KEY: apiKey } },
    });
    const client = new Client({ name: 'cms-agent-context7', version: '1.0.0' });
    await client.connect(transport);
    const ext = await externalMcp(
      client,
      (d) => `${d} (Context7 — up-to-date official library documentation.)`,
      'Use the Context7 tools (resolve-library-id, query-docs) to check current API ' +
        'documentation for libraries and frameworks instead of relying on memorized APIs.',
    );
    return {
      ...ext,
      // The connection outlives the turn; per-turn close must not kill it.
      close: async () => {},
      // A dead shared connection must degrade to a tool error the model can
      // act on (a throw aborts the turn) and reconnect on the next turn.
      async callTool(name, input) {
        try {
          return await ext.callTool(name, input);
        } catch (err) {
          g.__context7 = null;
          return JSON.stringify({
            error: `Context7 call failed: ${err instanceof Error ? err.message : err}. The connection will be re-established on the next turn.`,
          });
        }
      },
    };
  } catch (err) {
    warnOnce(`connect failed (${err instanceof Error ? err.message : err})`);
    g.__context7 = null;
    return null;
  }
}
