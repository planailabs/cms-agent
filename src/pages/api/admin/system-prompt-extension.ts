/**
 * Per-user system prompt extensions (ported from chat/'s admin API).
 * GET ?userId=… ; PUT { userId, content } (empty content deletes).
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
  const userId = url.searchParams.get('userId');
  if (!userId) return json({ error: 'userId required' }, 400);
  const ext = await prisma.systemPromptExtension.findUnique({ where: { userId } });
  return json({ content: ext?.content ?? '' });
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  let body: { userId?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.userId) return json({ error: 'userId required' }, 400);

  const content = body.content?.trim() ?? '';
  if (!content) {
    await prisma.systemPromptExtension.deleteMany({ where: { userId: body.userId } });
    return json({ ok: true, deleted: true });
  }
  await prisma.systemPromptExtension.upsert({
    where: { userId: body.userId },
    create: { userId: body.userId, content },
    update: { content },
  });
  return json({ ok: true });
};
