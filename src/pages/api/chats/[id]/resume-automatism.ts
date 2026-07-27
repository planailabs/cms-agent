/**
 * POST /api/chats/:id/resume-automatism — user-triggered resume of the
 * paused automatism reachable from this chat (same semantics as the agent's
 * resume_automatism tool; the Resume button in the step bar posts here).
 */
export const prerender = false;

import type { APIRoute } from 'astro';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ params, locals }) => {
  const { prisma } = await import('@/lib/db');
  const { chatAccessDenied } = await import('@/lib/chatAccess');
  const chat = await prisma.chat.findUnique({
    where: { id: params.id! },
    select: { createdById: true },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  const denied = await chatAccessDenied(locals.user!, chat);
  if (denied) return denied;
  await import('@/lib/publish/publisher'); // ensures automatism types are registered
  const { findPausedAutomatism, resumeAutomatism } = await import('@/lib/automatism');
  const paused = await findPausedAutomatism(params.id!);
  if (!paused) return json({ error: 'No paused automatism is tied to this chat.' }, 404);
  const ok = await resumeAutomatism(paused.id);
  if (!ok) return json({ error: 'The automatism is no longer paused.' }, 409);
  return json({ ok: true, resumed: paused.type, step: paused.step });
};
