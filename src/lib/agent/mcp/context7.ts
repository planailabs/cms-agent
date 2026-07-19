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

export async function attachContext7(): Promise<ExternalMcp | null> {
  // Read directly (not via env()) so partially-configured test envs stay quiet
  const apiKey = process.env.CONTEXT7_API_KEY;
  if (!apiKey) return null;

  try {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { CONTEXT7_API_KEY: apiKey } },
    });
    const client = new Client({ name: 'cms-agent-context7', version: '1.0.0' });
    await client.connect(transport);
    return await externalMcp(
      client,
      (d) => `${d} (Context7 — up-to-date official library documentation.)`,
    );
  } catch (err) {
    warnOnce(`connect failed (${err instanceof Error ? err.message : err})`);
    return null;
  }
}
