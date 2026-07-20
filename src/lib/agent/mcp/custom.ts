/**
 * Custom MCP servers — admin-configured, merged into the agent's tool set.
 * Config is the generic `mcpServers` standard (stdio: command/args/env,
 * web: url) read from ${VAR_DIR}/mcp.json.
 *
 * The whole mcporter runtime lives INSIDE the bwrap jail: a bundled bridge
 * (bridgeEntry.ts) is staged into the jail HOME together with a copy of the
 * config and spawned through sandboxCommand, then attached like every other
 * external MCP over stdio. Stdio servers therefore run jailed — they must
 * exist in the sandbox toolset (node/npx, python3, uv, pnpm, yarn) and see
 * neither host paths nor the app's env/secrets; web servers dial out from
 * the jail and need SANDBOX_ALLOW_NETWORK.
 *
 * Config stays in VAR_DIR (admin volume), never the managed site repo, so
 * only admins decide what runs. The bridge is a process-wide singleton
 * (per-turn attach reuses it; ExternalMcp.close is a no-op); config mtime
 * changes tear it down and start a fresh one. Fails soft at every level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { env } from '@/lib/env';
import { ensureSandbox, sandboxCommand, sandboxHomeDir } from '@/lib/sandbox';
import { externalMcp, type ExternalMcp } from './external';

const SESSION_KEY = 'mcp-bridge';
const BRIDGE_FILE = 'mcp-bridge.cjs';
const BRIDGE_CONFIG = 'mcp-bridge.json';

interface CustomMcpState {
  configMtimeMs: number;
  attachment: Promise<ExternalMcp | null>;
  client: Client | null;
}

// Survive Vite HMR module reloads in dev (same pattern as preview/manager)
const g = globalThis as unknown as { __customMcp?: CustomMcpState | null };

const configPath = () => path.join(path.resolve(env().VAR_DIR), 'mcp.json');

let bridgeCache: string | null = null;
/**
 * The bridge source: embedded by the virtual:mcp-bridge Vite plugin in the
 * server build (and astro dev); bundled on the fly from src in vitest,
 * where the plugin is absent.
 */
async function bridgeCode(): Promise<string> {
  if (bridgeCache) return bridgeCache;
  try {
    bridgeCache = (await import('virtual:mcp-bridge')).default;
  } catch {
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [path.resolve(process.cwd(), 'src/lib/agent/mcp/bridgeEntry.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node26',
      // Prefer ESM builds: UMD entries (jsonc-parser) hide requires from
      // esbuild's static analysis and break at runtime in the jail.
      mainFields: ['module', 'main'],
      legalComments: 'none',
    });
    bridgeCache = result.outputFiles[0].text;
  }
  return bridgeCache;
}

const serverNames = (): string[] => {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return Object.keys(raw.mcpServers ?? {});
  } catch {
    return [];
  }
};

/** Attach the sandboxed bridge for all configured servers; [] without config. */
export async function attachCustomMcps(): Promise<ExternalMcp[]> {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(configPath()).mtimeMs;
  } catch {
    // no config file — feature off
    if (g.__customMcp) void closeState(g.__customMcp);
    g.__customMcp = null;
    return [];
  }

  if (g.__customMcp && g.__customMcp.configMtimeMs === mtimeMs) {
    const a = await g.__customMcp.attachment;
    return a ? [a] : [];
  }
  if (g.__customMcp) void closeState(g.__customMcp);

  const state: CustomMcpState = {
    configMtimeMs: mtimeMs,
    client: null,
    attachment: Promise.resolve(null),
  };
  state.attachment = (async (): Promise<ExternalMcp | null> => {
    const sb = await ensureSandbox();
    const home = sandboxHomeDir(SESSION_KEY);
    fs.writeFileSync(path.join(home, BRIDGE_FILE), await bridgeCode());
    fs.copyFileSync(configPath(), path.join(home, BRIDGE_CONFIG));
    // An empty dedicated dir for the jail's writable /work — never a worktree.
    const workDir = path.join(path.resolve(env().VAR_DIR), 'mcp-bridge-work');
    fs.mkdirSync(workDir, { recursive: true });

    // In-jail the session home is /home/sandbox; the none-mode fallback runs
    // with HOME = the host dir itself.
    const bridgePath =
      sb.mode === 'none' ? path.join(home, BRIDGE_FILE) : `/home/sandbox/${BRIDGE_FILE}`;
    const { command, args } = sandboxCommand(sb, ['node', bridgePath], {
      cwd: workDir,
      sessionKey: SESSION_KEY,
    });
    const client = new Client({ name: 'cms-agent-custom-mcp', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command, args }));
    state.client = client;

    // Tool names/descriptions arrive pre-annotated from the bridge.
    const ext = await externalMcp(
      client,
      (d) => d,
      `Tools prefixed mcp_ come from the admin-connected MCP servers ` +
        `(${serverNames().join(', ')}), running sandboxed; use them when they fit the task.`,
    );
    if (ext.toolNames.size === 0) {
      // No server delivered tools — a idle bridge child is useless, drop it.
      state.client = null;
      await client.close().catch(() => {});
      return null;
    }
    // The bridge outlives the turn; per-turn close must not kill it.
    return { ...ext, close: async () => {} };
  })().catch((err: unknown) => {
    console.warn(
      `[mcp] bridge for ${configPath()} failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  });
  g.__customMcp = state;
  const attachment = await state.attachment;
  return attachment ? [attachment] : [];
}

/** Must match the bridge's tool-name prefixing (bridgeEntry.ts safe()). */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);

/**
 * Per-server attachment status for the capabilities modal: one row per
 * configured server, with the (prefixed) tools the bridge exposes for it.
 * Reuses the shared bridge — attaching is exactly what a chat turn does.
 */
export async function customMcpCapabilities(): Promise<
  Array<{ name: string; attached: boolean; reason?: string; tools: string[] }>
> {
  const names = serverNames();
  if (names.length === 0) return [];
  const attachments = await attachCustomMcps();
  const tools = attachments[0] ? [...attachments[0].toolNames] : [];
  return names.map((name) => {
    const own = tools.filter((t) => t.startsWith(`mcp_${safeName(name)}_`)).sort();
    return own.length > 0
      ? { name, attached: true, tools: own }
      : { name, attached: false, reason: 'unavailable', tools: [] };
  });
}

async function closeState(state: CustomMcpState): Promise<void> {
  try {
    await state.attachment;
    await state.client?.close();
  } catch {
    /* old bridge teardown must not affect the new one */
  }
}
