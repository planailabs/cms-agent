/**
 * Autonomy grants — admin only, never implicit (medved §11.4).
 * GET lists grants; POST creates; DELETE ?id= revokes.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/adminGuard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const grantSchema = z.object({
  userId: z.string().nullable().optional(),
  actions: z.array(z.enum(['implement', 'publish'])).min(1),
  pathScope: z.array(z.string()).min(1),
  maxRisk: z.enum(['content', 'template', 'code', 'dependency']).default('content'),
  maxExecutions: z.number().int().positive().max(100).default(1),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date(),
  onError: z.enum(['stop', 'notify']).default('stop'),
});

export const GET: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const grants = await prisma.autonomyGrant.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true } }, createdBy: { select: { name: true } } },
  });
  return json({ grants });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = grantSchema.safeParse(raw);
  if (!parsed.success) return json({ error: parsed.error.message }, 400);
  const grant = await prisma.autonomyGrant.create({
    data: {
      ...parsed.data,
      userId: parsed.data.userId ?? null,
      validFrom: parsed.data.validFrom ?? new Date(),
      createdById: locals.user!.id,
    },
  });
  return json({ grant }, 201);
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  await prisma.autonomyGrant.update({ where: { id }, data: { revokedAt: new Date() } });
  return json({ ok: true });
};
