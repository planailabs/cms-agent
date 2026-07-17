/**
 * POST /api/chat/message — ported from chat/'s message.ts.
 * Body: { chatId, type: 'message'|'answer', text, pageContext? }
 * Acquires the per-chat turn lock, fires the handler asynchronously and
 * returns 202; all output arrives via SSE.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { acquireTurnLock, broadcast, releaseTurnLock } from '@/lib/agent/bus';
import { handleChatMessage } from '@/lib/agent/handler';
import { prisma } from '@/lib/db';
import type { IncomingChatMessage } from '@/lib/agent/types';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;

  let body: IncomingChatMessage;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.chatId || !body.type || typeof body.text !== 'string') {
    return json({ error: 'Invalid body: need { chatId, type, text }' }, 400);
  }

  // While an automatism is actively running its steps, its chat takes no
  // user messages — wait for it to finish or pause (then the agent engages).
  if (body.type === 'message') {
    const { automatismStateFor } = await import('@/lib/automatism');
    const auto = await automatismStateFor(body.chatId);
    if (auto?.status === 'running') {
      return json({ error: 'The automatism is running — messages are accepted once it pauses or finishes.' }, 409);
    }
  }

  const lockId = acquireTurnLock(body.chatId);
  if (!lockId) {
    return json({ error: 'A conversation turn is already in progress' }, 409);
  }

  const locale = user.language ?? 'en';

  void (async () => {
    try {
      // A starting turn clears the previous failure (Retry sends 'continue')
      await prisma.chat
        .updateMany({ where: { id: body.chatId, lastError: { not: null } }, data: { lastError: null } })
        .catch(() => {});
      await handleChatMessage(user.id, locale, body);
      // Autonomy grants may auto-approve a plan the turn just proposed
      const { maybeAutoApprovePlan } = await import('@/lib/autonomy');
      await maybeAutoApprovePlan(body.chatId, user.id);
    } catch (err) {
      console.error('[chat/message] Handler error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      // Persist so the error (and its Retry) survives reloads
      await prisma.chat
        .updateMany({ where: { id: body.chatId }, data: { lastError: message } })
        .catch(() => {});
      broadcast(body.chatId, 'error', { type: 'error', message });
    } finally {
      releaseTurnLock(body.chatId, lockId);
    }
  })();

  return json({ status: 'accepted' }, 202);
};
