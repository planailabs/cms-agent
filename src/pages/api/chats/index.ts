/**
 * POST /api/chats — create a chat on a branch (starts in the PLAN phase).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  let body: { branchId?: string; title?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.branchId) return json({ error: 'branchId required' }, 400);

  const branch = await prisma.branch.findUnique({ where: { id: body.branchId } });
  if (!branch) return json({ error: 'Branch not found' }, 404);

  const chat = await prisma.chat.create({
    data: {
      branchId: branch.id,
      title: body.title?.trim() || 'New chat',
      createdById: user.id,
    },
  });
  return json({ chat }, 201);
};
