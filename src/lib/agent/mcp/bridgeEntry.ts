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
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRuntime, loadServerDefinitions } from 'mcporter';

// Config location: MCP_BRIDGE_CONFIG when set (the worktree bridge points it
// at /work/.mcp.json), else HOME-relative — /home/sandbox in the jail, the
// staged session home dir in the SANDBOX_MODE=none dev fallback.
const CONFIG_PATH = process.env.MCP_BRIDGE_CONFIG ?? path.join(os.homedir(), 'mcp-bridge.json');
/** Below the app-side SDK client's 60s default, so the inner call loses. */
const CALL_TIMEOUT_MS = 55_000;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);

interface Entry {
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

/**
 * Tool annotations, straight from the server.
 *
 * mcporter's listTools() projects each tool down to name/description/schemas
 * and drops `annotations`, but the app gates on readOnlyHint — that is what
 * lets a declared-read-only tool be offered during the read-only PLAN phase
 * (see agent/mcp/policy.ts). The raw MCP client keeps the full tool, and
 * connect() reuses the same cached connection listTools() just used, so this
 * costs one extra request and no extra process.
 */
async function annotationsFor(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  server: string,
): Promise<Map<string, unknown>> {
  try {
    const { client } = await runtime.connect(server, { disableOAuth: true });
    const { tools } = await client.listTools();
    return new Map(tools.filter((t) => t.annotations).map((t) => [t.name, t.annotations]));
  } catch (err) {
    // Non-fatal: without annotations the tool is simply treated as mutating.
    console.error(
      `[mcp-bridge] annotations for "${server}" unavailable (${err instanceof Error ? err.message : err})`,
    );
    return new Map();
  }
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
      const annotations = await annotationsFor(runtime, def.name);
      for (const t of list) {
        tools.set(`mcp_${safe(def.name)}_${safe(t.name)}`, {
          server: def.name,
          tool: t.name,
          description: `${t.description ?? ''} (MCP server "${def.name}")`,
          inputSchema: t.inputSchema ?? { type: 'object' },
          annotations: annotations.get(t.name),
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
      ...(e.annotations ? { annotations: e.annotations as Record<string, unknown> } : {}),
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
