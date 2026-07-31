/**
 * MCP groups — the unit the agent loads tools in.
 *
 * A group is either an APPLICATION (one server: `context7`, `codebase-memory`,
 * or any server name from a config) or a SET spanning several servers, declared
 * per server in the config the servers already live in:
 *
 *   "mcpServers": {
 *     "brave": { "command": "…", "groups": ["search"], "description": "Web search" },
 *     "exa":   { "command": "…", "groups": ["search"] }
 *   }
 *
 * A server is ALWAYS also a group of its own, so `load_mcp` works without any
 * extra configuration. Unknown keys are ours alone: mcporter reads the same
 * file and ignores what it does not know (test/mcp-groups.test.ts pins that).
 *
 * Only the groups a chat has loaded are attached and exposed (see mcp/index.ts)
 * — that is the whole point: a turn should not pay for tools it never calls.
 * DEFAULT_GROUPS is what every turn starts with; everything else the agent asks
 * for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';
import type { ChatKind } from '../tools/registry';
import type { WorkflowPhase } from '../types';

/** Repo-scoped config file name (the cross-tool `.mcp.json` convention). */
export const WORKTREE_CONFIG = '.mcp.json';

/** Must match the bridge's tool-name prefixing (bridgeEntry.ts safe()). */
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);

/** Known integrations we ship and configure ourselves — one group each. */
export const CODEBASE_MEMORY_GROUP = 'codebase-memory';
export const CONTEXT7_GROUP = 'context7';

export interface McpGroup {
  id: string;
  description: string;
  /** 'known' = a shipped integration; the others name the config it came from. */
  source: 'known' | 'config' | 'worktree';
  /** Servers the group covers. Empty for known groups — the attachment IS the group. */
  servers: string[];
}

/** A group with the state a prompt or a query answer needs. */
export interface McpGroupView extends McpGroup {
  loaded: boolean;
  /** Loaded by the phase default, so unload_mcp refuses to drop it. */
  isDefault: boolean;
}

/**
 * Groups every chat starts with. The codebase graph answers "where is this
 * used", which is the first question of nearly every editorial turn, so it is
 * worth its tool list; docs and custom servers are not, until the work asks
 * for them. The deployments monitor reads publication state and nothing else.
 */
const DEFAULT_GROUPS: Record<ChatKind, string[]> = {
  workflow: [CODEBASE_MEMORY_GROUP],
  deployment: [CODEBASE_MEMORY_GROUP],
  deployments: [],
};

export function defaultGroups(kind: ChatKind, _phase: WorkflowPhase): string[] {
  return DEFAULT_GROUPS[kind] ?? DEFAULT_GROUPS.workflow;
}

/** One server entry of an `mcpServers` config, with our two extra keys. */
export interface McpServerEntry {
  name: string;
  groups: string[];
  description: string;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];

/** Server entries of a config file; [] when it is missing or unreadable. */
export function serverEntries(configPath: string): McpServerEntry[] {
  let raw: { mcpServers?: Record<string, unknown> };
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof raw;
  } catch {
    return [];
  }
  return Object.entries(raw.mcpServers ?? {}).map(([name, value]) => {
    const cfg = (value ?? {}) as { groups?: unknown; group?: unknown; description?: unknown };
    return {
      name,
      groups: [...asStrings(cfg.groups), ...(typeof cfg.group === 'string' ? [cfg.group] : [])],
      description: typeof cfg.description === 'string' ? cfg.description : '',
    };
  });
}

export const globalConfigPath = (): string =>
  path.join(path.resolve(env().VAR_DIR), 'mcp.json');

const KNOWN_GROUPS: McpGroup[] = [
  {
    id: CODEBASE_MEMORY_GROUP,
    description:
      'Codebase graph of this branch — symbols, call paths, dependencies, architecture, ' +
      'instead of grepping for structure.',
    source: 'known',
    servers: [],
  },
  {
    id: CONTEXT7_GROUP,
    description:
      'Context7 — up-to-date official documentation for libraries and frameworks, ' +
      'instead of memorized APIs.',
    source: 'known',
    servers: [],
  },
];

/**
 * Every group a chat could load: the known integrations plus one group per
 * configured server, plus the sets those servers declare. Context7 is listed
 * only when a key configures it — a group nobody can load is noise.
 */
export function groupIndex(worktreePath?: string): McpGroup[] {
  const groups = new Map<string, McpGroup>();
  for (const g of KNOWN_GROUPS) {
    if (g.id === CONTEXT7_GROUP && !process.env.CONTEXT7_API_KEY) continue;
    groups.set(g.id, { ...g });
  }

  const sources: Array<{ source: 'config' | 'worktree'; file: string }> = [];
  try {
    sources.push({ source: 'config', file: globalConfigPath() });
  } catch {
    // unconfigured env (e.g. astro build) — no admin config
  }
  if (worktreePath) {
    sources.push({ source: 'worktree', file: path.join(worktreePath, WORKTREE_CONFIG) });
  }

  for (const { source, file } of sources) {
    for (const entry of serverEntries(file)) {
      // The server's own group. A name colliding with an earlier source keeps
      // the earlier one, matching how index.ts dedupes colliding tool names.
      if (!groups.has(entry.name)) {
        groups.set(entry.name, {
          id: entry.name,
          description: entry.description || `MCP server "${entry.name}".`,
          source,
          servers: [entry.name],
        });
      }
      for (const setId of entry.groups) {
        const existing = groups.get(setId);
        if (existing && existing.source === 'known') continue; // never shadow a known group
        if (existing) {
          if (!existing.servers.includes(entry.name)) existing.servers.push(entry.name);
        } else {
          groups.set(setId, {
            id: setId,
            description: `Set of MCP servers.`,
            source,
            servers: [entry.name],
          });
        }
      }
    }
  }
  return [...groups.values()];
}

/** Server names the given groups cover, for one config source. */
export function serversForGroups(
  groups: string[],
  index: McpGroup[],
  source: 'config' | 'worktree',
): Set<string> {
  const wanted = new Set(groups);
  const servers = new Set<string>();
  for (const g of index) {
    if (g.source !== source || !wanted.has(g.id)) continue;
    for (const s of g.servers) servers.add(s);
  }
  return servers;
}

/**
 * Does a bridged tool belong to one of these servers? Bridge tool names are
 * `mcp_<safeName(server)>_<tool>` (bridgeEntry.ts), which is the only link
 * back from a tool to the server that served it.
 */
export function toolBelongsTo(toolName: string, servers: Set<string>): boolean {
  for (const server of servers) {
    if (toolName.startsWith(`mcp_${safeName(server)}_`)) return true;
  }
  return false;
}

/** Prompt/query view of the index for a chat's current load state. */
export function groupViews(
  index: McpGroup[],
  loaded: Set<string>,
  defaults: string[],
): McpGroupView[] {
  const isDefault = new Set(defaults);
  return index.map((g) => ({ ...g, loaded: loaded.has(g.id), isDefault: isDefault.has(g.id) }));
}
