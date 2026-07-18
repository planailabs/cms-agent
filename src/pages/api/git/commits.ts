/**
 * GET /api/git/commits?branch=<name>&limit= — commit list for the git modal.
 *
 * The branch is either a target branch (a Branch row: all commits shown
 * normally, no target) or a chat's work branch (commits already on the chat's
 * target branch are flagged `onTarget` so the UI can grey them out).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { branchCommits } from '@/lib/git/engine';

export const GET: APIRoute = async ({ url }) => {
  const name = url.searchParams.get('branch') ?? '';
  const maxCount = Math.min(Number(url.searchParams.get('limit') ?? 100), 300);

  // Only names our own DB knows reach git (work branches are c-<id>, which
  // validateBranchName deliberately reserves — so existence IS the check).
  // Target branch? All commits are its own. Otherwise resolve the owning
  // chat's target branch so its commits can be greyed out.
  let target: string | null = null;
  const branchRow = await prisma.branch.findUnique({ where: { name } });
  if (!branchRow) {
    const chat = await prisma.chat.findFirst({
      where: { workBranch: name },
      include: { branch: true },
    });
    if (!chat) {
      return new Response(JSON.stringify({ error: 'Branch not found' }), { status: 404 });
    }
    target = chat.branch.name;
  }

  try {
    const commits = await branchCommits(name, target, maxCount);
    return new Response(JSON.stringify({ branch: name, target, commits }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Known to the DB but absent from the repo (e.g. worktree never created)
    return new Response(JSON.stringify({ error: 'Branch has no git history' }), { status: 404 });
  }
};
