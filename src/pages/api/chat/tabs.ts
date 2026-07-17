/**
 * Per-user preview tabs of a chat. GET ?chatId= returns the caller's saved
 * tabs (null if none); PUT upserts them and broadcasts `tabs_updated` on the
 * chat's SSE channel so the user's other sessions follow live (clients
 * ignore events for other users / their own clientId echo).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { broadcast } from '@/lib/agent/bus';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const chatId = url.searchParams.get('chatId');
  if (!chatId) return json({ error: 'chatId required' }, 400);
  const row = await prisma.chatTabs.findUnique({
    where: { chatId_userId: { chatId, userId: user.id } },
  });
  return json(row ? { tabs: row.tabs, activeIndex: row.activeIndex } : { tabs: null });
};

const putSchema = z.object({
  chatId: z.string().min(1),
  tabs: z.array(z.string().min(1).max(2000)).min(1).max(50),
  activeIndex: z.number().int().min(0),
  clientId: z.string().max(64).optional(),
});

export const PUT: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Unauthorized' }, 401);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) return json({ error: parsed.error.message }, 400);
  const { chatId, tabs, clientId } = parsed.data;
  const activeIndex = Math.min(parsed.data.activeIndex, tabs.length - 1);

  const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } });
  if (!chat) return json({ error: 'Chat not found' }, 404);

  await prisma.chatTabs.upsert({
    where: { chatId_userId: { chatId, userId: user.id } },
    create: { chatId, userId: user.id, tabs, activeIndex },
    update: { tabs, activeIndex },
  });
  broadcast(chatId, 'tabs_updated', { userId: user.id, tabs, activeIndex, clientId });
  return json({ ok: true });
};
