/**
 * GET  /api/memory — pending candidates + active approved memories.
 * POST /api/memory — { id, action: 'approve' | 'reject' | 'revoke' }.
 * Any editor may decide (medved §23: editors confirm project conventions).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { approveMemory, rejectMemory, revokeMemory } from '@/lib/memory';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async () => {
  const [candidates, approved] = await Promise.all([
    prisma.memoryCandidate.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.approvedMemory.findMany({
      where: { revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { approvedBy: { select: { name: true } } },
    }),
  ]);
  return json({ candidates, approved });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  let body: { id?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.id || !body.action) return json({ error: 'id and action required' }, 400);

  try {
    if (body.action === 'approve') await approveMemory(body.id, user.id);
    else if (body.action === 'reject') await rejectMemory(body.id);
    else if (body.action === 'revoke') await revokeMemory(body.id);
    else return json({ error: `Unknown action: ${body.action}` }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Failed' }, 409);
  }
  return json({ ok: true });
};
