/**
 * Custom MCP servers — merged into the agent's tool set from TWO sources,
 * both the generic `mcpServers` standard (stdio: command/args/env, web: url):
 *
 *  - ${VAR_DIR}/mcp.json    admin-global, staged into the bridge session HOME
 *  - <worktree>/.mcp.json   per-branch, committed in the SITE REPO — each
 *                           worktree carries its own set
 *
 * Every bridge runs INSIDE the sandbox (bridgeEntry.ts bundled as
 * virtual:mcp-bridge, spawned via sandboxCommand): it hosts the mcporter
 * runtime and re-exposes all tools over one stdio MCP connection with
 * mcp_<server>_<tool> names. Repo-defined stdio servers are safe BECAUSE of
 * that jail — they execute with exactly the privileges the agent's
 * run_command already has there (worktree at /work, clean env, sandbox
 * toolset) and MUST never run outside it. Name collisions: the global config
 * wins (index.ts merges globals first and dedupes tool names).
 *
 * Bridges are cached per source (global / worktree path) across turns;
 * a config mtime change or removal tears the bridge down. Fails soft.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { env } from '@/lib/env';
import {
  ensureSandbox,
  sandboxCommand,
  sandboxHomeDir,
  type SandboxState,
} from '@/lib/sandbox';
import { externalMcp, type ExternalMcp } from './external';
import { WORKTREE_CONFIG, globalConfigPath, safeName, serverEntries } from './groups';

const GLOBAL_SESSION_KEY = 'mcp-bridge';
const BRIDGE_FILE = 'mcp-bridge.cjs';
const BRIDGE_CONFIG = 'mcp-bridge.json';

/** Chat context for the per-worktree bridge. */
export interface CustomMcpContext {
  worktreePath: string;
  chatId: string;
}

interface BridgeState {
  configMtimeMs: number;
  attachment: Promise<ExternalMcp | null>;
  client: Client | null;
}

// Survive Vite HMR module reloads in dev (same pattern as preview/manager)
const g = globalThis as unknown as { __customMcp?: Map<string, BridgeState> };
const bridges = (): Map<string, BridgeState> => (g.__customMcp ??= new Map());

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

const serverNames = (configPath: string): string[] =>
  serverEntries(configPath).map((e) => e.name);

interface StartOpts {
  configHostPath: string;
  /** Copy the config into the session HOME (sources outside any jail bind). */
  stageConfig: boolean;
  /** Bridge reads the config from the WORKTREE (/work in the jail). */
  workConfig: boolean;
  cwd: string;
  sessionKey: string;
  hint: (names: string[]) => string;
}

async function startBridge(
  opts: StartOpts,
): Promise<{ ext: ExternalMcp | null; client: Client | null }> {
  const sb: SandboxState = await ensureSandbox();
  const home = sandboxHomeDir(opts.sessionKey);
  fs.writeFileSync(path.join(home, BRIDGE_FILE), await bridgeCode());
  if (opts.stageConfig) fs.copyFileSync(opts.configHostPath, path.join(home, BRIDGE_CONFIG));

  // In-jail the session home is /home/sandbox and the cwd is /work; the
  // none-mode fallback runs with the host paths directly.
  const bridgePath =
    sb.mode === 'none' ? path.join(home, BRIDGE_FILE) : `/home/sandbox/${BRIDGE_FILE}`;
  const extraEnv = opts.workConfig
    ? {
        MCP_BRIDGE_CONFIG:
          sb.mode === 'none'
            ? path.join(opts.cwd, WORKTREE_CONFIG)
            : `/work/${WORKTREE_CONFIG}`,
      }
    : undefined;

  const { command, args } = sandboxCommand(sb, ['node', bridgePath], {
    cwd: opts.cwd,
    sessionKey: opts.sessionKey,
    extraEnv,
  });
  const client = new Client({ name: 'cms-agent-custom-mcp', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command, args }));

  // Tool names/descriptions arrive pre-annotated from the bridge.
  const ext = await externalMcp(client, (d) => d, opts.hint(serverNames(opts.configHostPath)));
  if (ext.toolNames.size === 0) {
    // No server delivered tools — an idle bridge child is useless, drop it.
    await client.close().catch(() => {});
    return { ext: null, client: null };
  }
  // The bridge outlives the turn; per-turn close must not kill it.
  return { ext: { ...ext, close: async () => {} }, client };
}

async function cachedAttach(
  key: string,
  configHostPath: string,
  make: () => Promise<{ ext: ExternalMcp | null; client: Client | null }>,
): Promise<ExternalMcp | null> {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(configHostPath).mtimeMs;
  } catch {
    // config gone (or worktree removed) — tear the bridge down
    const old = bridges().get(key);
    if (old) {
      void closeState(old);
      bridges().delete(key);
    }
    return null;
  }

  const cur = bridges().get(key);
  if (cur && cur.configMtimeMs === mtimeMs) return cur.attachment;
  if (cur) void closeState(cur);

  const state: BridgeState = {
    configMtimeMs: mtimeMs,
    client: null,
    attachment: Promise.resolve(null),
  };
  state.attachment = make()
    .then(({ ext, client }) => {
      state.client = client;
      return ext;
    })
    .catch((err: unknown) => {
      console.warn(
        `[mcp] bridge for ${configHostPath} failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });
  bridges().set(key, state);
  return state.attachment;
}

/** Attachments labeled by source (capabilities view needs the split). */
export interface CustomMcpAttachments {
  global: ExternalMcp | null;
  worktree: ExternalMcp | null;
}

/**
 * Server names each source is wanted for. A source whose servers are all in
 * unloaded MCP groups is never started at all — a bridge is a jail process
 * plus one connection per configured server, and nothing in the turn can
 * reach its tools anyway (see mcp/groups.ts). Omitted: attach everything,
 * which is what the capabilities view wants.
 */
export interface WantedServers {
  config: Set<string>;
  worktree: Set<string>;
}

/** Nothing wanted from this config — skip the spawn without touching the cache. */
const skipSource = (configPath: string, wanted: Set<string> | undefined): boolean =>
  wanted !== undefined && !serverNames(configPath).some((n) => wanted.has(n));

export async function attachCustomMcpsLabeled(
  ctx?: CustomMcpContext,
  wanted?: WantedServers,
): Promise<CustomMcpAttachments> {
  const globalExt = skipSource(globalConfigPath(), wanted?.config)
    ? null
    : await cachedAttach('global', globalConfigPath(), () =>
    startBridge({
      configHostPath: globalConfigPath(),
      stageConfig: true,
      workConfig: false,
      cwd: globalWorkDir(),
      sessionKey: GLOBAL_SESSION_KEY,
      hint: (names) =>
        `Tools prefixed mcp_ come from the admin-connected MCP servers ` +
        `(${names.join(', ')}), running sandboxed; use them when they fit the task.`,
    }),
  );

  let wtExt: ExternalMcp | null = null;
  const wtConfig = ctx?.worktreePath ? path.join(ctx.worktreePath, WORKTREE_CONFIG) : '';
  if (ctx?.worktreePath && !skipSource(wtConfig, wanted?.worktree)) {
    const cfg = wtConfig;
    wtExt = await cachedAttach(`wt:${ctx.worktreePath}`, cfg, () =>
      startBridge({
        configHostPath: cfg,
        stageConfig: false,
        workConfig: true,
        cwd: ctx.worktreePath,
        sessionKey: ctx.chatId,
        hint: (names) =>
          `Tools prefixed mcp_ come from this branch's ${WORKTREE_CONFIG} MCP servers ` +
          `(${names.join(', ')}), running sandboxed with the branch checkout at /work.`,
      }),
    );
  }

  return { global: globalExt, worktree: wtExt };
}

/**
 * Attach the sandboxed bridges: the admin-global config, plus the chat
 * branch's repo config when a context is given. [] without any config.
 * Order matters — global first; index.ts dedupes colliding tool names in
 * that order, so the global config wins.
 */
export async function attachCustomMcps(
  ctx?: CustomMcpContext,
  wanted?: WantedServers,
): Promise<ExternalMcp[]> {
  const { global, worktree } = await attachCustomMcpsLabeled(ctx, wanted);
  return [global, worktree].filter((e): e is ExternalMcp => e !== null);
}

/** Empty dedicated dir for the global bridge's jail /work — never a worktree. */
function globalWorkDir(): string {
  const dir = path.join(path.resolve(env().VAR_DIR), 'mcp-bridge-work');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function closeState(state: BridgeState): Promise<void> {
  try {
    await state.attachment;
    await state.client?.close();
  } catch {
    /* old bridge teardown must not affect the new one */
  }
}

/**
 * Per-server attachment status for the capabilities modal: one row per
 * configured server (global + branch), with the (prefixed) tools its bridge
 * exposes. Reuses the shared bridges — attaching is what a chat turn does.
 */
export async function customMcpCapabilities(
  ctx?: CustomMcpContext,
): Promise<
  Array<{ name: string; source: 'config' | 'worktree'; attached: boolean; reason?: string; tools: string[] }>
> {
  const { global, worktree } = await attachCustomMcpsLabeled(ctx);
  const toolsOf = (ext: ExternalMcp | null, name: string): string[] =>
    ext ? [...ext.toolNames].filter((t) => t.startsWith(`mcp_${safeName(name)}_`)).sort() : [];

  const sources: Array<{
    source: 'config' | 'worktree';
    configPath: string;
    ext: ExternalMcp | null;
  }> = [{ source: 'config', configPath: globalConfigPath(), ext: global }];
  if (ctx?.worktreePath) {
    sources.push({
      source: 'worktree',
      configPath: path.join(ctx.worktreePath, WORKTREE_CONFIG),
      ext: worktree,
    });
  }

  return sources.flatMap(({ source, configPath, ext }) =>
    serverNames(configPath).map((name) => {
      const tools = toolsOf(ext, name);
      return tools.length > 0
        ? { name, source, attached: true, tools }
        : { name, source, attached: false, reason: 'unavailable' as const, tools: [] };
    }),
  );
}
