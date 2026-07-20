/**
 * Custom MCP servers — admin-configured, merged into the agent's tool set.
 * Config is the generic `mcpServers` standard (stdio: command/args/env,
 * web: url) read from ${VAR_DIR}/mcp.json through the mcporter runtime,
 * which handles both transports, connection caching, and timeouts.
 *
 * SECURITY: the config lives in VAR_DIR (admin-controlled volume), NEVER in
 * the managed site repo — stdio entries execute commands on the host, so an
 * agent-writable location would be an RCE vector.
 *
 * The runtime is a process-wide singleton (stdio children are expensive to
 * spawn per turn); per-turn ExternalMcp wrappers never close it. Config
 * edits are picked up via mtime, replacing the runtime. Fails soft per
 * server: an unreachable server is skipped with a warning, the rest attach.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from 'mcporter';
import { env } from '@/lib/env';
import type { ExternalMcp } from './external';

const CALL_TIMEOUT_MS = 60_000;

interface CustomMcpState {
  configMtimeMs: number;
  attachments: Promise<ExternalMcp[]>;
  runtime: Runtime | null;
}

// Survive Vite HMR module reloads in dev (same pattern as preview/manager)
const g = globalThis as unknown as { __customMcp?: CustomMcpState | null };

const configPath = () => path.join(path.resolve(env().VAR_DIR), 'mcp.json');

/** OpenAI tool-name charset: [A-Za-z0-9_-], capped length. */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);

const resultText = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
};

async function buildAttachments(runtime: Runtime): Promise<ExternalMcp[]> {
  const attachments: ExternalMcp[] = [];
  for (const server of runtime.listServers()) {
    try {
      const tools = await runtime.listTools(server, { includeSchema: true, disableOAuth: true });
      const prefix = `mcp_${safeName(server)}_`;
      /** prefixed OpenAI name -> real MCP tool name */
      const names = new Map(tools.map((t) => [`${prefix}${safeName(t.name)}`, t.name]));
      attachments.push({
        toolNames: new Set(names.keys()),
        openAiTools: tools.map((t) => {
          // Strip the $schema marker — some OpenAI-compatible backends
          // reject parameters carrying it (see ./external.ts).
          const { $schema: _drop, ...parameters } =
            (t.inputSchema as Record<string, unknown>) ?? {};
          return {
            type: 'function' as const,
            function: {
              name: `${prefix}${safeName(t.name)}`,
              description: `${t.description ?? ''} (MCP server "${server}")`,
              parameters: Object.keys(parameters).length > 0 ? parameters : { type: 'object' },
            },
          };
        }),
        promptHint:
          `Tools prefixed ${prefix} come from the admin-connected "${server}" MCP server; ` +
          'use them when they fit the task.',
        async callTool(name, input) {
          const result = await runtime.callTool(server, names.get(name) ?? name, {
            args: input,
            timeoutMs: CALL_TIMEOUT_MS,
            disableOAuth: true,
          });
          return resultText(result);
        },
        // The shared runtime outlives the turn — closing happens on config
        // change (see below), not per bridge.
        close: async () => {},
      });
    } catch (err) {
      console.warn(
        `[mcp] server "${server}" unavailable (${err instanceof Error ? err.message : err}) — skipped`,
      );
    }
  }
  return attachments;
}

/** Attach all configured custom MCP servers; [] when no config exists. */
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
    return g.__customMcp.attachments;
  }
  if (g.__customMcp) void closeState(g.__customMcp);

  const state: CustomMcpState = {
    configMtimeMs: mtimeMs,
    runtime: null,
    attachments: Promise.resolve([]),
  };
  state.attachments = (async () => {
    const { createRuntime, loadServerDefinitions } = await import('mcporter');
    // mcporter layers imports from other clients' configs (~/.claude.json,
    // …) on top of the explicit file — keep ONLY entries from our file so
    // the attached set is exactly what the admin wrote there.
    const defs = (await loadServerDefinitions({ configPath: configPath() })).filter(
      (d) => d.source?.kind === 'local' && d.source.path === configPath(),
    );
    if (defs.length === 0) return [];
    const runtime = await createRuntime({
      servers: defs,
      clientInfo: { name: 'cms-agent', version: '1.0.0' },
    });
    state.runtime = runtime;
    return buildAttachments(runtime);
  })().catch((err: unknown) => {
    console.warn(
      `[mcp] config ${configPath()} failed to load: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  });
  g.__customMcp = state;
  return state.attachments;
}

async function closeState(state: CustomMcpState): Promise<void> {
  try {
    await state.attachments;
    await state.runtime?.close();
  } catch {
    /* old runtime teardown must not affect the new one */
  }
}
