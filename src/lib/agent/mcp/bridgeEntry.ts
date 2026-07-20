/**
 * MCP bridge — runs INSIDE the bwrap jail (bundled to one self-contained
 * file by custom.ts / the virtual:mcp-bridge plugin, staged into the jail
 * HOME). Hosts the whole mcporter runtime: connects every server from
 * /home/sandbox/mcp-bridge.json and re-exposes all their tools over ONE
 * stdio MCP server with mcp_<server>_<tool> names.
 *
 * Because the runtime lives here, stdio MCP servers are spawned inside the
 * jail too: they see only the sandbox toolset (node, npx, python3, uv, …),
 * the empty /work, the bridge HOME — and the clean bwrap env, never the
 * app's secrets. Web servers dial out from the jail (SANDBOX_ALLOW_NETWORK).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRuntime, loadServerDefinitions } from 'mcporter';

const CONFIG_PATH = '/home/sandbox/mcp-bridge.json';
/** Below the app-side SDK client's 60s default, so the inner call loses. */
const CALL_TIMEOUT_MS = 55_000;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);

interface Entry {
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
}

async function main(): Promise<void> {
  const defs = (await loadServerDefinitions({ configPath: CONFIG_PATH })).filter(
    (d) => d.source?.kind === 'local',
  );
  const runtime = await createRuntime({
    servers: defs,
    clientInfo: { name: 'cms-agent-mcp-bridge', version: '1.0.0' },
  });

  const tools = new Map<string, Entry>();
  for (const def of defs) {
    try {
      const list = await runtime.listTools(def.name, { includeSchema: true, disableOAuth: true });
      for (const t of list) {
        tools.set(`mcp_${safe(def.name)}_${safe(t.name)}`, {
          server: def.name,
          tool: t.name,
          description: `${t.description ?? ''} (MCP server "${def.name}")`,
          inputSchema: t.inputSchema ?? { type: 'object' },
        });
      }
    } catch (err) {
      console.error(
        `[mcp-bridge] server "${def.name}" unavailable (${err instanceof Error ? err.message : err}) — skipped`,
      );
    }
  }

  const server = new Server(
    { name: 'cms-agent-mcp-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.entries()].map(([name, e]) => ({
      name,
      description: e.description,
      inputSchema: e.inputSchema as { type: 'object' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const entry = tools.get(req.params.name);
    if (!entry) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const result = await runtime.callTool(entry.server, entry.tool, {
      args: req.params.arguments ?? {},
      timeoutMs: CALL_TIMEOUT_MS,
      disableOAuth: true,
    });
    // mcporter returns the raw CallToolResult — pass content through as-is.
    return result && typeof result === 'object' && 'content' in result
      ? (result as { content: Array<{ type: 'text'; text: string }> })
      : { content: [{ type: 'text' as const, text: String(result) }] };
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error('[mcp-bridge] fatal:', err);
  process.exit(1);
});
