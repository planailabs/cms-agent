/**
 * POST /api/branches/[id]/restore {sha, paths?} — apply an old version (whole
 * tree or selected files) onto the branch head as a NEW commit. History is
 * never rewritten; newer commits stay reachable (medved §12.5).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { withBranchLock } from '@/lib/agent/bus';
import { emitChatStatesForBranch } from '@/lib/agent/chatState';
import { restoreVersion } from '@/lib/git/engine';

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  let body: { sha?: string; paths?: string[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  // Strict sha only — a leading '-' would be parsed by git as an option.
  if (!body.sha || !/^[0-9a-f]{7,40}$/i.test(body.sha)) {
    return new Response(JSON.stringify({ error: 'sha required (hex commit sha)' }), { status: 400 });
  }

  const branch = await prisma.branch.findUnique({ where: { id: params.id! } });
  if (!branch) return new Response(JSON.stringify({ error: 'Branch not found' }), { status: 404 });

  const restoreSha = await withBranchLock(params.id!, () =>
    restoreVersion(branch.name, body.sha!, body.paths, { name: user.name, email: user.email }),
  );

  // The restore commit moves the branch head, so every chat on it is showing
  // a stale sha. Push the authoritative snapshot rather than an event: the
  // 'version_restored' event this used to send had no listener at all, so the
  // workspace only caught up on the next reload.
  if (restoreSha) emitChatStatesForBranch(branch.id);

  return new Response(JSON.stringify({ ok: true, restoreSha }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
