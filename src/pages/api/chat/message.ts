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
import { chatAccessDenied } from '@/lib/chatAccess';
import { parseMessage } from '@/lib/commands';
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

  // Validate attachments: chat-scoped, owned by this user, within the cap.
  if (body.attachmentIds?.length) {
    const ids = [...new Set(body.attachmentIds)];
    const { getAttachmentsOnePerMessage } = await import('@/lib/settings');
    if ((await getAttachmentsOnePerMessage()) && ids.length > 1) {
      return json({ error: 'Only one file per message is allowed.' }, 400);
    }
    const owned = await prisma.upload.count({
      where: { id: { in: ids }, userId: user.id, chatId: body.chatId },
    });
    if (owned !== ids.length) {
      return json({ error: 'One or more attachments are invalid for this chat.' }, 400);
    }
    body.attachmentIds = ids;
  }

  // A leading /command switches something on for the chat and is stripped
  // from the text the agent sees. Parsed server-side: the composer's chip is
  // a preview of this decision, never the decision itself. Only typed
  // messages carry commands — an answer resolves a pending tool call.
  let command: string | undefined;
  if (body.type === 'message') {
    const parsed = parseMessage(body.text);
    if (parsed.command) {
      command = parsed.command.name;
      body.text = parsed.text;
      body.command = command;
    }
  }

  // Archived chats are done — nothing may start a turn on them again.
  const chat = await prisma.chat.findUnique({
    where: { id: body.chatId },
    select: { archivedAt: true, turnPhase: true, pendingQuestion: true, createdById: true },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  const denied = await chatAccessDenied(user, chat);
  if (denied) return denied;
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

  // The effect lands on the chat before the turn starts, so the very turn
  // the command was typed on already runs under it.
  if (command) {
    const { findCommand } = await import('@/lib/commands');
    const effect = findCommand(command)?.effect;
    if (effect) await prisma.chat.update({ where: { id: body.chatId }, data: effect });
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

  // Request-only UI locale follows live SSE language changes without changing
  // the saved profile preference or any chat/history state.
  const locale =
    body.uiLocale === 'en' || body.uiLocale === 'de' ? body.uiLocale : (user.language ?? 'en');

  void (async () => {
    try {
      // A starting turn clears the previous failure (Retry sends 'continue')
      await prisma.chat
        .updateMany({ where: { id: body.chatId, lastError: { not: null } }, data: { lastError: null } })
        .catch(() => {});
      await handleChatMessage(user.id, locale, body);
    } catch (err) {
      console.error('[chat/message] Handler error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      // Persist so the error (and its Retry) survives reloads
      await prisma.chat
        .updateMany({ where: { id: body.chatId }, data: { lastError: message } })
        .catch(() => {});
      broadcast(body.chatId, 'error', { type: 'error', message });
      const { emitChatState } = await import('@/lib/agent/chatState');
      emitChatState(body.chatId);
    } finally {
      releaseTurnLock(body.chatId, lockId);
    }
  })();

  return json({ status: 'accepted' }, 202);
};
