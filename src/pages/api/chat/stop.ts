/**
 * POST /api/chat/stop — interrupt the running agent loop of one chat.
 * Body: { chatId }
 *
 * Sets the flag the loop checks between streamed chunks and between tool
 * calls; the turn then ends itself (transcript note, 'stopped' + 'done' on
 * SSE). Nothing is killed mid-flight, so a tool already running — a build, an
 * install — finishes first, and the worktree is never left half-written.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { hasActiveTurn, requestTurnStop } from '@/lib/agent/bus';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  let body: { chatId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.chatId) return json({ error: 'Invalid body: need { chatId }' }, 400);

  const chat = await prisma.chat.findUnique({
    where: { id: body.chatId },
    select: { archivedAt: true, turnPhase: true, pendingQuestion: true, createdById: true },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  const denied = await chatAccessDenied(locals.user!, chat);
  if (denied) return denied;

  // Idempotent: a second click while the first stop is still landing is fine.
  if (!requestTurnStop(body.chatId)) {
    return json({ error: 'No turn is running in this chat.' }, 409);
  }
  return json({ status: 'stopping', active: hasActiveTurn(body.chatId) }, 202);
};
