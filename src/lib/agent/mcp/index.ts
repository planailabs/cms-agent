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
import { executeTool, isClientSideTool, toolsForTurn, type ToolContext } from '../tools/registry';
import { recordToolCall, startTimer } from '@/lib/metrics';
import { attachCodebaseMemory } from './codebaseMemory';
import { attachContext7 } from './context7';
import { attachCustomMcpsLabeled } from './custom';
import { readOnlyView, type ExternalMcp } from './external';
import { mcpAccess, type McpAccess } from './policy';
import {
  CODEBASE_MEMORY_GROUP,
  CONTEXT7_GROUP,
  defaultGroups,
  groupIndex,
  groupViews,
  serversForGroups,
  toolBelongsTo,
  type McpGroupView,
} from './groups';

/** In-process tools include image generation, builds and deploys — the SDK's
 *  60s default request timeout (-32001) kills them mid-run. */
const OWN_TOOL_TIMEOUT_MS = 600_000;

export interface McpBridge {
  /** OpenAI function-tool definitions for the current phase and loaded groups. */
  asOpenAiTools(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  /** System-prompt guidance lines for the external MCPs that actually attached. */
  promptHints(): string[];
  /** Dispatch a model tool call through MCP; returns the tool result string. */
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
  /** Load/unload MCP groups mid-turn (also published on the tool context). */
  control: McpControl;
  close(): Promise<void>;
}

/** What one group's load attempt produced. */
export interface McpLoadResult {
  id: string;
  tools: string[];
  error?: string;
}

/**
 * The agent's handle on its own tool set. `load` attaches what a group needs
 * and returns the tools that just became callable — the next round's tool list
 * carries them (toolLoop rebuilds it every round).
 */
export interface McpControl {
  index(): McpGroupView[];
  loaded(): string[];
  load(ids: string[]): Promise<McpLoadResult[]>;
  unload(ids: string[]): { dropped: string[]; refused: string[] };
}

/** Attached sources, keyed so a source is started at most once per turn. */
type SourceKey = 'known:codebase-memory' | 'known:context7' | 'custom:config' | 'custom:worktree';

/**
 * Apply an access decision to what a source actually attached: drop the
 * failures, narrow to read-only where required, and forget a server whose
 * tools were all filtered away — its prompt hint would advertise nothing.
 */
function applyAccess(attachments: Array<ExternalMcp | null>, access: McpAccess): ExternalMcp[] {
  return attachments
    .filter((e): e is ExternalMcp => e !== null)
    .map((e) => (access.readOnlyOnly ? readOnlyView(e) : e))
    .filter((e) => e.toolNames.size > 0);
}

/**
 * Native tools go through an in-memory MCP server/client pair rather than
 * being handed to the model directly, and that hop earns its keep twice:
 *
 * - the SDK's registerTool() does the Zod → JSON-Schema conversion. Bypassing
 *   it means hand-writing that converter for refinements, defaults, unions,
 *   optionals and every future schema feature — a well-known source of subtle
 *   wrongness, in exchange for deleting perhaps twenty lines of glue.
 * - it is the merge point. External MCP tools (codebase memory, Context7, the
 *   admin config, the branch's .mcp.json) arrive as MCP already, so one list
 *   and one dispatch path serve both. A bypass would create a second of each.
 *
 * The transport is in-process (InMemoryTransport), so what is actually being
 * paid for is a function call and a JSON round trip per tool call.
 */
export async function createMcpBridge(ctx: ToolContext): Promise<McpBridge> {
  const server = new McpServer({ name: 'cms-agent', version: '1.0.0' });

  for (const tool of toolsForTurn(ctx)) {
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

  // External MCPs (sandboxed codebase graph, Context7 docs, custom servers
  // from the admin config + the branch's .mcp.json) — merged into the tool
  // set, but under two gates. policy.ts decides whether a source attaches at
  // all and whether it is reduced to its declared read-only tools; groups.ts
  // decides whether the chat asked for it in the first place. A group nobody
  // loaded is never attached, so its server is never even started.
  // Order matters: on tool-name collisions the earlier source wins
  // (asOpenAiTools dedupes, callTool matches first).
  const known = mcpAccess('known', { phase: ctx.workflowPhase, kind: ctx.chatKind });
  const custom = mcpAccess('custom', { phase: ctx.workflowPhase, kind: ctx.chatKind });
  const defaults = defaultGroups(ctx.chatKind, ctx.workflowPhase);
  // Shared with the tool context: load_mcp mutates this set and the next
  // round's tool list follows.
  const loaded = (ctx.loadedMcpGroups ??= new Set(defaults));
  for (const id of defaults) loaded.add(id);

  const attached = new Map<SourceKey, ExternalMcp>();
  const customCtx = ctx.worktreePath
    ? { worktreePath: ctx.worktreePath, chatId: ctx.chatId }
    : undefined;

  /** Servers of the loaded groups, per config source. */
  const wantedServers = () => ({
    config: serversForGroups([...loaded], groupIndex(ctx.worktreePath), 'config'),
    worktree: serversForGroups([...loaded], groupIndex(ctx.worktreePath), 'worktree'),
  });

  /** Attach whatever the currently loaded groups need and is not up yet. */
  const attachLoaded = async (): Promise<void> => {
    const jobs: Array<Promise<void>> = [];
    const add = (key: SourceKey, get: () => Promise<ExternalMcp | null>, access: McpAccess) => {
      if (attached.has(key) || !access.attach) return;
      jobs.push(
        get().then((ext) => {
          const [ok] = applyAccess([ext], access);
          if (ok) attached.set(key, ok);
        }),
      );
    };
    if (loaded.has(CODEBASE_MEMORY_GROUP)) {
      add('known:codebase-memory', () => attachCodebaseMemory(ctx), known);
    }
    if (loaded.has(CONTEXT7_GROUP)) add('known:context7', () => attachContext7(), known);

    const wanted = wantedServers();
    const needConfig = wanted.config.size > 0 && !attached.has('custom:config');
    const needWorktree = wanted.worktree.size > 0 && !attached.has('custom:worktree');
    if (custom.attach && (needConfig || needWorktree)) {
      jobs.push(
        (async () => {
          const { global, worktree } = await attachCustomMcpsLabeled(customCtx, wanted);
          const [g] = applyAccess([global], custom);
          if (g && needConfig) attached.set('custom:config', g);
          const [w] = applyAccess([worktree], custom);
          if (w && needWorktree) attached.set('custom:worktree', w);
        })(),
      );
    }
    await Promise.all(jobs);
  };

  /**
   * Attached sources narrowed to what the loaded groups actually cover. A
   * custom bridge serves every server of its config, so its tools are filtered
   * by name prefix; a known source is all-or-nothing.
   */
  const visible = (): ExternalMcp[] => {
    const wanted = wantedServers();
    const out: ExternalMcp[] = [];
    for (const [key, ext] of attached) {
      if (key === 'known:codebase-memory') {
        if (loaded.has(CODEBASE_MEMORY_GROUP)) out.push(ext);
      } else if (key === 'known:context7') {
        if (loaded.has(CONTEXT7_GROUP)) out.push(ext);
      } else {
        const servers = key === 'custom:config' ? wanted.config : wanted.worktree;
        const names = new Set([...ext.toolNames].filter((n) => toolBelongsTo(n, servers)));
        if (names.size === 0) continue;
        out.push({
          ...ext,
          toolNames: names,
          openAiTools: ext.openAiTools.filter((t) => names.has(t.function.name)),
        });
      }
    }
    return out;
  };

  await attachLoaded();

  const control: McpControl = {
    index: () => groupViews(groupIndex(ctx.worktreePath), loaded, defaults),
    loaded: () => [...loaded],
    async load(ids) {
      const index = groupIndex(ctx.worktreePath);
      const results: McpLoadResult[] = [];
      const fresh = ids.filter((id) => {
        if (!index.some((g) => g.id === id)) {
          results.push({ id, tools: [], error: `Unknown MCP group "${id}" — call query_mcps.` });
          return false;
        }
        return true;
      });
      const before = new Set(visible().flatMap((e) => [...e.toolNames]));
      for (const id of fresh) loaded.add(id);
      await attachLoaded();
      const after = visible();
      for (const id of fresh) {
        const servers = new Set(index.find((g) => g.id === id)?.servers ?? []);
        const tools = after
          .flatMap((e) => [...e.toolNames])
          .filter((n) => !before.has(n) && (servers.size === 0 || toolBelongsTo(n, servers)));
        results.push(
          tools.length > 0
            ? { id, tools }
            : {
                id,
                tools: [],
                error:
                  `Group "${id}" exposed no tools — its server is unavailable, or the ` +
                  `${ctx.workflowPhase} phase allows only tools that declare themselves read-only.`,
              },
        );
      }
      return results;
    },
    unload(ids) {
      const dropped: string[] = [];
      const refused: string[] = [];
      for (const id of ids) {
        if (defaults.includes(id)) refused.push(id);
        else if (loaded.delete(id)) dropped.push(id);
      }
      return { dropped, refused };
    },
  };
  ctx.mcp = control;

  /** The dispatch itself: a loaded external group's tool first, otherwise the
   *  in-process server. Wrapped by callTool below, which times it. */
  async function callToolInner(name: string, input: Record<string, unknown>): Promise<string> {
    const ext = visible().find((e) => e.toolNames.has(name));
    if (ext) return ext.callTool(name, input);
    // Attached but not in a loaded group: the model is calling a tool it saw
    // before an unload, or one it never had. Say so instead of failing blind.
    const unloaded = [...attached.values()].find((e) => e.toolNames.has(name));
    if (unloaded) {
      return JSON.stringify({
        error: `Tool "${name}" belongs to an MCP group that is not loaded — call load_mcp for it first (query_mcps finds the group).`,
      });
    }
    try {
      const result = await client.callTool({ name, arguments: input }, undefined, {
        timeout: OWN_TOOL_TIMEOUT_MS,
      });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      return content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
    } catch (err) {
      // Unknown/removed tool names (e.g. scratch_* from pre-.scratch chat
      // histories) must not abort the turn — return an error the model can
      // act on instead.
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `Unknown or failed tool "${name}": ${msg}. Scratch files live in the .scratch/ directory — use write_file/read_file/list_dir on .scratch/ paths.`,
      });
    }
  }

  return {
    control,
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
      // Dedupe colliding tool names across externals (e.g. the same server
      // name in the admin config and a branch .mcp.json) — first wins.
      const seen = new Set(own.map((t) => t.function.name));
      const extTools = visible()
        .flatMap((e) => e.openAiTools)
        .filter((t) => (seen.has(t.function.name) ? false : (seen.add(t.function.name), true)));
      return [...own, ...extTools];
    },
    promptHints() {
      return visible().map((e) => e.promptHint);
    },
    /**
     * Every tool call the agent makes passes through here — built-in,
     * in-process MCP and custom stdio/web servers alike — so this is where
     * they are timed. A stdio server that hangs is otherwise indistinguishable
     * from a model that is thinking.
     */
    async callTool(name, input) {
      const stop = startTimer();
      let outcome: 'ok' | 'error' = 'ok';
      try {
        const result = await callToolInner(name, input);
        // A failed tool call answers with an error payload rather than
        // throwing — the model has to be able to act on it — so that payload
        // is what "failed" looks like from here. ponytail: prefix check; give
        // callToolInner a typed result if anything else ever needs to know.
        if (result.startsWith('{"error"')) outcome = 'error';
        return result;
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        recordToolCall(name, outcome, stop());
      }
    },
    async close() {
      await Promise.allSettled([
        client.close(),
        server.close(),
        ...[...attached.values()].map((e) => e.close()),
      ]);
    },
  };
}

export { isClientSideTool };
