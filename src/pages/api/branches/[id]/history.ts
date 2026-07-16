/**
 * GET /api/branches/[id]/history — commit history for the version navigator.
 * Each entry can be previewed read-only at v-<shortsha>.BASE_DOMAIN.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { branchLog } from '@/lib/git/engine';

export const GET: APIRoute = async ({ params, url }) => {
  const branch = await prisma.branch.findUnique({ where: { id: params.id! } });
  if (!branch) return new Response(JSON.stringify({ error: 'Branch not found' }), { status: 404 });

  const maxCount = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const commits = await branchLog(branch.name, maxCount);
  const executions = await prisma.execution.findMany({
    where: { chat: { branchId: branch.id } },
    select: { sha: true, summary: true, revertedBySha: true, chatId: true },
  });
  const bySha = new Map(executions.map((e) => [e.sha, e]));

  return new Response(
    JSON.stringify({
      branch: branch.name,
      commits: commits.map((c) => ({
        ...c,
        previewLabel: `v-${c.sha.slice(0, 12)}`,
        execution: bySha.get(c.sha) ?? null,
      })),
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
