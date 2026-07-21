/**
 * GET /api/window-sessions/[id] — one saved window (own only), with the
 * full state blob for restoring. DELETE removes it.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const session = await prisma.windowSession.findUnique({ where: { id: params.id! } });
  if (!session || session.userId !== user.id) return json({ error: 'Not found' }, 404);
  return json({
    id: session.id,
    label: session.label,
    state: session.state,
    updatedAt: session.updatedAt,
  });
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const deleted = await prisma.windowSession.deleteMany({
    where: { id: params.id!, userId: user.id },
  });
  return json({ ok: deleted.count > 0 });
};
