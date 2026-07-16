/**
 * GET  /api/branches — all branches with their chats (shared visibility).
 * POST /api/branches — create a branch (DNS-safe name; becomes git branch
 * and <name>.BASE_DOMAIN preview subdomain).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { syncBranchesFromRepo } from '@/lib/branchSync';
import { ensureBranch, ensureWorktree, validateBranchName } from '@/lib/git/engine';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async () => {
  // Git is the source of truth for target branches — mirror it (throttled)
  let missing: string[] = [];
  try {
    missing = (await syncBranchesFromRepo()).missing;
  } catch (err) {
    console.error('[branches] git sync failed:', err);
  }
  const branches = await prisma.branch.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      chats: {
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          title: true,
          workflowPhase: true,
          workBranch: true,
          kind: true,
          updatedAt: true,
          createdBy: { select: { id: true, name: true } },
        },
      },
      createdBy: { select: { id: true, name: true } },
    },
  });
  return json({ branches, missingFromGit: missing });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const name = body.name?.trim().toLowerCase() ?? '';
  const invalid = validateBranchName(name);
  if (invalid) return json({ error: invalid }, 400);

  const existing = await prisma.branch.findUnique({ where: { name } });
  if (existing) return json({ error: `Branch "${name}" already exists` }, 409);

  await ensureBranch(name);
  await ensureWorktree(name);

  const branch = await prisma.branch.create({
    data: { name, createdById: user.id },
  });
  return json({ branch }, 201);
};
