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

  // Archived chats are done — nothing may start a turn on them again.
  const chat = await prisma.chat.findUnique({
    where: { id: body.chatId },
    select: { archivedAt: true, turnPhase: true, pendingQuestion: true },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  if (chat.archivedAt) {
    return json({ error: 'This chat is archived and no longer accepts messages.' }, 409);
  }

  // A proposed plan awaits a DECISION (approve / request changes) — a typed
  // message must not resolve the propose_plan tool as a plain answer and skip
  // the workflow transition. Route it as a change request instead.
  const pending = chat.pendingQuestion as { toolName?: string } | null;
  if (
    body.type === 'answer' &&
    body.text !== '__cancel__' &&
    chat.turnPhase === 'waiting_for_answer' &&
    pending?.toolName === 'propose_plan'
  ) {
    const { requestChanges, WorkflowError } = await import('@/lib/agent/workflow');
    try {
      await requestChanges({
        chatId: body.chatId,
        actor: { id: user.id, name: user.name ?? '', email: user.email ?? '', language: user.language ?? undefined },
        feedback: body.text,
      });
      return json({ status: 'accepted', routedTo: 'request-changes' }, 202);
    } catch (err) {
      if (err instanceof WorkflowError) return json({ error: err.message }, err.status);
      throw err;
    }
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
    let turnOk = false;
    try {
      // A starting turn clears the previous failure (Retry sends 'continue')
      await prisma.chat
        .updateMany({ where: { id: body.chatId, lastError: { not: null } }, data: { lastError: null } })
        .catch(() => {});
      await handleChatMessage(user.id, locale, body);
      turnOk = true;
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
    // Autonomy grants may auto-approve a plan the turn just proposed. This
    // must run AFTER the turn lock is released: approvePlan resumes the turn
    // via acquireTurnLock, which silently no-ops while this request still
    // holds the lock — stranding the chat in execute + waiting_for_answer.
    if (turnOk) {
      try {
        const { maybeAutoApprovePlan } = await import('@/lib/autonomy');
        await maybeAutoApprovePlan(body.chatId, user.id);
      } catch (err) {
        console.error('[chat/message] autonomy error:', err);
      }
    }
  })();

  return json({ status: 'accepted' }, 202);
};
