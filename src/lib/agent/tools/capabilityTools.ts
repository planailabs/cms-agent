/**
 * Capability discovery and loading.
 *
 * The system prompt no longer lists everything the agent could possibly use:
 * skills come pre-selected by the router (lib/agent/skillRouter) and MCP tools
 * only arrive for the groups the chat has loaded. These four tools are the way
 * back to the rest — search the full indexes, and pull an MCP group's tools
 * into the tool set when the work turns out to need it.
 */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { skillsForChat } from '../plugins';
import { score } from '../capabilityIndex';
import { ALL_PHASES } from '../types';
import { registerTool, type ToolContext, type ToolDef } from './registry';

const KINDS = ['workflow', 'deployment', 'deployments'] as const;

const querySkillsTool: ToolDef = {
  name: 'query_skills',
  description:
    'Search ALL available skills by keyword — the system prompt lists only the ones ' +
    'selected for this turn. Returns names and descriptions; use_skill then loads one.',
  schema: z.object({
    query: z.string().min(1).describe('Keywords, e.g. "deploy rollback" or "image alt text"'),
    limit: z.number().int().min(1).max(25).optional().describe('Max results (default 10)'),
  }),
  phases: ALL_PHASES,
  kinds: [...KINDS],
  async execute(input, ctx) {
    const skills = skillsForChat(ctx.worktreePath);
    const ranked = skills
      .map((s) => ({
        skill: s,
        // The body carries the words a description often leaves out; the head
        // of it is enough to match on without reading whole skills.
        score: score(input.query, s.name, `${s.description} ${s.body.slice(0, 2000)}`),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 10);

    return JSON.stringify({
      total: skills.length,
      matches: ranked.map(({ skill }) => ({
        name: skill.name,
        plugin: skill.plugin,
        description: skill.description.slice(0, 300),
        scripts: skill.scripts.map((s) => s.id),
      })),
      ...(ranked.length === 0
        ? { note: `No skill matched. All skills: ${skills.map((s) => s.name).join(', ') || '(none)'}` }
        : {}),
    });
  },
};

/** The bridge publishes its control handle on the context; without it there is
 *  no tool set to talk about (only possible if a caller built its own bridge). */
const control = (ctx: ToolContext) => {
  if (!ctx.mcp) throw new Error('MCP groups are unavailable in this turn.');
  return ctx.mcp;
};

const queryMcpsTool: ToolDef = {
  name: 'query_mcps',
  description:
    'Search the MCP groups this chat can load (applications like "context7", and sets ' +
    'like "search"). Returns each group with the servers it covers and whether it is ' +
    'already loaded. load_mcp then makes its tools callable.',
  schema: z.object({
    query: z
      .string()
      .optional()
      .describe('Keywords, e.g. "documentation" or "search". Omit to list every group.'),
    limit: z.number().int().min(1).max(25).optional().describe('Max results (default 10)'),
  }),
  phases: ALL_PHASES,
  kinds: [...KINDS],
  async execute(input, ctx) {
    const groups = control(ctx).index();
    const rows = (
      input.query
        ? groups
            .map((g) => ({ g, score: score(input.query, `${g.id} ${g.servers.join(' ')}`, g.description) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((r) => r.g)
        : groups
    ).slice(0, input.limit ?? 10);

    return JSON.stringify({
      loaded: control(ctx).loaded(),
      groups: rows.map((g) => ({
        id: g.id,
        description: g.description,
        source: g.source,
        servers: g.servers,
        loaded: g.loaded,
      })),
      ...(rows.length === 0 ? { note: `No group matched. Groups: ${groups.map((g) => g.id).join(', ')}` } : {}),
    });
  },
};

/** Write the chat's load state through, so the next turn starts where this one
 *  left off. A failed write is reported, never swallowed — the agent would
 *  otherwise believe a group stays loaded when it does not. */
async function persist(ctx: ToolContext): Promise<string | undefined> {
  try {
    await prisma.chat.update({
      where: { id: ctx.chatId },
      data: { loadedMcpGroups: control(ctx).loaded() },
    });
    return undefined;
  } catch (err) {
    return `Loaded for this turn, but saving the state failed (${err instanceof Error ? err.message : err}) — it may reset on the next turn.`;
  }
}

const loadMcpTool: ToolDef = {
  name: 'load_mcp',
  description:
    'Load one or more MCP groups so their tools become callable. The tools appear in ' +
    'your tool list from the NEXT round on (this call returns their names), and stay ' +
    'loaded for the rest of the chat.',
  schema: z.object({
    groups: z
      .array(z.string().min(1))
      .min(1)
      .describe('Group ids exactly as query_mcps or the system prompt lists them'),
  }),
  phases: ALL_PHASES,
  kinds: [...KINDS],
  async execute(input, ctx) {
    const results = await control(ctx).load(input.groups);
    const warning = results.some((r) => r.tools.length > 0) ? await persist(ctx) : undefined;
    return JSON.stringify({
      loaded: control(ctx).loaded(),
      results,
      ...(warning ? { warning } : {}),
    });
  },
};

const unloadMcpTool: ToolDef = {
  name: 'unload_mcp',
  description:
    'Drop MCP groups you no longer need, removing their tools from your tool set. ' +
    'The groups this chat always has cannot be dropped.',
  schema: z.object({ groups: z.array(z.string().min(1)).min(1) }),
  phases: ALL_PHASES,
  kinds: [...KINDS],
  async execute(input, ctx) {
    const { dropped, refused } = control(ctx).unload(input.groups);
    const warning = dropped.length > 0 ? await persist(ctx) : undefined;
    return JSON.stringify({
      dropped,
      ...(refused.length > 0 ? { refused, reason: 'always loaded in this chat' } : {}),
      loaded: control(ctx).loaded(),
      ...(warning ? { warning } : {}),
    });
  },
};

export function registerCapabilityTools(): void {
  registerTool(querySkillsTool);
  registerTool(queryMcpsTool);
  registerTool(loadMcpTool);
  registerTool(unloadMcpTool);
}
