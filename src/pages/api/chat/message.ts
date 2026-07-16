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

  const lockId = acquireTurnLock(body.chatId);
  if (!lockId) {
    return json({ error: 'A conversation turn is already in progress' }, 409);
  }

  const locale = user.language ?? 'en';

  void (async () => {
    try {
      await handleChatMessage(user.id, locale, body);
      // Autonomy grants may auto-approve a plan the turn just proposed
      const { maybeAutoApprovePlan } = await import('@/lib/autonomy');
      await maybeAutoApprovePlan(body.chatId, user.id);
    } catch (err) {
      console.error('[chat/message] Handler error:', err);
      broadcast(body.chatId, 'error', {
        type: 'error',
        message: err instanceof Error ? err.message : 'Internal error',
      });
    } finally {
      releaseTurnLock(body.chatId, lockId);
    }
  })();

  return json({ status: 'accepted' }, 202);
};
