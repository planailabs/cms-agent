/**
 * GET /api/agent/capabilities?chat=<id> — per-chat agent capability status
 * for the skills/MCP overview modal: available skills (installed plugins +
 * branch-local, with shadowing), plugin rules, and the live attachment state
 * of the external MCPs (probed the same way a chat turn attaches them).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';
import { ensureWorktree } from '@/lib/git/engine';
import {
  loadAdminRules,
  loadAdminSkills,
  loadBranchSkills,
  loadPluginRegistry,
  type PluginSkill,
} from '@/lib/agent/plugins';
import { attachCodebaseMemory } from '@/lib/agent/mcp/codebaseMemory';
import { attachContext7 } from '@/lib/agent/mcp/context7';
import { customMcpCapabilities } from '@/lib/agent/mcp/custom';
import type { ExternalMcp } from '@/lib/agent/mcp/external';
import type { ToolContext } from '@/lib/agent/tools/registry';

export interface CapabilityMcp {
  name: string;
  attached: boolean;
  /** Machine reason when not attached: no-worktree | unavailable | no-key */
  reason?: string;
  tools: string[];
  /** codebase-memory: raw index_status result for the chat's graph. */
  indexStatus?: string;
}

const probe = async (
  ext: ExternalMcp | null,
  status?: (ext: ExternalMcp) => Promise<string | undefined>,
): Promise<Pick<CapabilityMcp, 'tools' | 'indexStatus'> | null> => {
  if (!ext) return null;
  const indexStatus = await status?.(ext).catch(() => undefined);
  await ext.close();
  return { tools: [...ext.toolNames].sort(), indexStatus };
};

/** index_status needs a project name — resolve it via list_projects first
 *  (the per-chat HOME holds exactly the chat's own index). */
const cbmIndexStatus = async (ext: ExternalMcp): Promise<string | undefined> => {
  const listed = await ext.callTool('list_projects', {});
  const projects = (JSON.parse(listed) as { projects?: Array<{ name?: string }> }).projects ?? [];
  const project = projects[0]?.name;
  // No project yet (indexing still running / failed) — the listing carries the hint
  if (!project) return listed;
  return ext.callTool('index_status', { project });
};

/** Script rows for the capabilities modal: what it is, and where it came from. */
const scriptRows = (skill: PluginSkill) =>
  skill.scripts.map((s) => ({
    id: s.id,
    description: s.description,
    origin: s.origin,
    flags: Object.keys(s.flags).filter((f) => s.flags[f as keyof typeof s.flags]),
  }));

export const GET: APIRoute = async ({ url, locals }) => {
  const chatId = url.searchParams.get('chat') ?? '';
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, include: { branch: true } });
  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  }
  const denied = await chatAccessDenied(locals.user!, chat);
  if (denied) return denied;

  let worktreePath = '';
  if (chat.kind === 'workflow') {
    worktreePath = await ensureWorktree(chat.workBranch, chat.branch.name).catch(() => '');
  }

  const reg = loadPluginRegistry();
  const branchSkills = worktreePath ? loadBranchSkills(worktreePath) : [];
  const adminSkills = loadAdminSkills();
  const branchNames = new Set(branchSkills.map((s) => s.name.toLowerCase()));
  // Shadowing order matches skillsForChat: branch > admin > plugin.
  const upperNames = new Set([
    ...branchNames,
    ...adminSkills.map((s) => s.name.toLowerCase()),
  ]);
  const skills = [
    ...branchSkills.map((s) => ({
      name: s.name,
      description: s.description,
      plugin: s.plugin,
      source: 'branch' as const,
      shadowed: false,
      scripts: scriptRows(s),
    })),
    ...adminSkills.map((s) => ({
      name: s.name,
      description: s.description,
      plugin: s.plugin,
      source: 'admin' as const,
      shadowed: branchNames.has(s.name.toLowerCase()),
      scripts: scriptRows(s),
    })),
    ...reg.skills.map((s) => ({
      name: s.name,
      description: s.description,
      plugin: s.plugin,
      source: 'plugin' as const,
      shadowed: upperNames.has(s.name.toLowerCase()),
      scripts: scriptRows(s),
    })),
  ];

  const mcps: CapabilityMcp[] = [];

  const cbm = worktreePath
    ? await probe(await attachCodebaseMemory({ chatId, worktreePath } as ToolContext), cbmIndexStatus)
    : null;
  mcps.push(
    cbm
      ? { name: 'codebase-memory', attached: true, ...cbm }
      : {
          name: 'codebase-memory',
          attached: false,
          reason: worktreePath ? 'unavailable' : 'no-worktree',
          tools: [],
        },
  );

  // Custom servers — admin config (VAR_DIR/mcp.json) plus the branch's
  // .mcp.json — one row each, via the shared sandboxed bridges.
  mcps.push(
    ...(await customMcpCapabilities(
      worktreePath ? { worktreePath, chatId } : undefined,
    )),
  );

  const hasKey = Boolean(process.env.CONTEXT7_API_KEY);
  const c7 = hasKey ? await probe(await attachContext7()) : null;
  mcps.push(
    c7
      ? { name: 'context7', attached: true, ...c7 }
      : { name: 'context7', attached: false, reason: hasKey ? 'unavailable' : 'no-key', tools: [] },
  );

  return new Response(
    JSON.stringify({
      chatId,
      skills,
      rules: [...reg.rules, ...loadAdminRules()].map((r) => ({ plugin: r.plugin })),
      mcps,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
