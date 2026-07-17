/**
 * Admin branch management. GET lists CMS branches (DB + git + preview
 * state); DELETE ?name= removes a branch everywhere: its chats' work
 * branches (previews, worktrees, git refs), the git branch, and the DB row
 * (chats cascade). The default branch cannot be deleted.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import {
  defaultBranch,
  deleteBranch,
  listRepoBranches,
  removeWorktree,
  validateBranchName,
} from '@/lib/git/engine';
import { listInstances, stopInstance, clearStartError } from '@/lib/preview/manager';
import { requireAdmin } from '@/lib/adminGuard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const [dbBranches, gitBranches, def] = await Promise.all([
    prisma.branch.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        createdBy: { select: { email: true } },
        _count: { select: { chats: true, publications: true } },
      },
    }),
    listRepoBranches(),
    defaultBranch(),
  ]);
  const running = new Set(listInstances().map((i) => i.branch));
  const inDb = new Set(dbBranches.map((b) => b.name));
  const branches = [
    ...dbBranches.map((b) => ({
      name: b.name,
      createdBy: b.createdBy?.email ?? null,
      createdAt: b.createdAt,
      chats: b._count.chats,
      publications: b._count.publications,
      inGit: gitBranches.includes(b.name),
      running: running.has(b.name),
      isDefault: b.name === def,
    })),
    // git branches the DB doesn't know (e.g. the default branch)
    ...gitBranches
      .filter((name) => !inDb.has(name))
      .map((name) => ({
        name,
        createdBy: null,
        createdAt: null,
        chats: 0,
        publications: 0,
        inGit: true,
        running: running.has(name),
        isDefault: name === def,
      })),
  ];
  return json({ branches });
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const name = url.searchParams.get('name');
  if (!name) return json({ error: 'name required' }, 400);
  const invalid = validateBranchName(name);
  if (invalid) return json({ error: invalid }, 400);
  if (name === (await defaultBranch())) {
    return json({ error: 'Cannot delete the default branch' }, 400);
  }

  const branch = await prisma.branch.findUnique({
    where: { name },
    include: { chats: { select: { workBranch: true } } },
  });

  const workBranches = branch?.chats.map((c) => c.workBranch) ?? [];
  for (const b of [...workBranches, name]) {
    await stopInstance(b);
    clearStartError(b);
    await removeWorktree(b);
    await deleteBranch(b);
  }
  if (branch) await prisma.branch.delete({ where: { id: branch.id } });
  return json({ ok: true });
};
