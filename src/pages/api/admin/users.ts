/**
 * GET  /api/admin/users?q=… — search/list users with usage summary.
 * POST /api/admin/users — { userId, role } set role.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/adminGuard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const q = url.searchParams.get('q')?.trim();
  const users = await prisma.user.findMany({
    where: q ? { OR: [{ email: { contains: q } }, { name: { contains: q } }] } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, email: true, name: true, role: true, language: true, createdAt: true },
  });
  return json({ users });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  let body: { userId?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.userId || !['admin', 'editor'].includes(body.role ?? '')) {
    return json({ error: 'userId and role (admin|editor) required' }, 400);
  }
  await prisma.user.update({ where: { id: body.userId }, data: { role: body.role! } });
  return json({ ok: true });
};
