/**
 * Window sessions — passive per-window view-state storage ("soft window
 * session"): GET lists the caller's saved windows (newest first), PUT
 * upserts one (debounced client mirror) and prunes old ones. Restoring a
 * session never round-trips interactions — this is continuity storage only.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { prisma } from '@/lib/db';

const KEEP = 12;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const sessions = await prisma.windowSession.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    take: KEEP,
    select: { id: true, label: true, updatedAt: true },
  });
  return json({ sessions });
};

const PutBody = z.object({
  id: z.string().regex(ID_RE),
  label: z.string().max(120).default(''),
  state: z.record(z.string(), z.unknown()),
});

export const PUT: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const parsed = PutBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Invalid body' }, 400);
  const { id, label, state } = parsed.data;

  const existing = await prisma.windowSession.findUnique({ where: { id }, select: { userId: true } });
  if (existing && existing.userId !== user.id) return json({ error: 'Not yours' }, 403);

  await prisma.windowSession.upsert({
    where: { id },
    create: { id, userId: user.id, label, state: state as object },
    update: { label, state: state as object },
  });

  // Prune beyond the newest KEEP (per user)
  const stale = await prisma.windowSession.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    skip: KEEP,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.windowSession.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
  return json({ ok: true });
};
