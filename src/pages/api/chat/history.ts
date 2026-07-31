/**
 * GET /api/chat/history?chatId=… — message history for rendering.
 * Tool batches are omitted; assistant/user/cancel rows return display text.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';
import { normalizeBlocks } from '@/lib/messageBlocks';
import { buildChatState } from '@/lib/agent/chatState';

export const GET: APIRoute = async ({ url, locals }) => {
  const chatId = url.searchParams.get('chatId');
  if (!chatId) {
    return new Response(JSON.stringify({ error: 'chatId required' }), { status: 400 });
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  }
  const denied = await chatAccessDenied(locals.user!, chat);
  if (denied) return denied;
  const checkpoint = await prisma.message.findFirst({
    where: { chatId, role: 'compaction' },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  const rows = await prisma.message.findMany({
    where: { chatId, ...(checkpoint ? { ordinal: { gte: checkpoint.ordinal } } : {}) },
    orderBy: { ordinal: 'asc' },
  });

  // Attachments for user rows (rendered as chips; no thumbnails after reload).
  const userRowIds = rows.filter((r) => r.role === 'user').map((r) => r.id);
  const attachmentsByMsg = new Map<string, Array<{ id: string; filename: string; mime: string }>>();
  if (userRowIds.length) {
    const ups = await prisma.upload.findMany({
      where: { messageId: { in: userRowIds } },
      select: { id: true, filename: true, mime: true, messageId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const u of ups) {
      const list = attachmentsByMsg.get(u.messageId!) ?? [];
      list.push({ id: u.id, filename: u.filename, mime: u.mime });
      attachmentsByMsg.set(u.messageId!, list);
    }
  }

  // Flatten for rendering: assistant text bubbles plus one 'tool' entry per
  // executed call (name/input joined from the preceding assistant row's
  // tool_calls, result from the tool batch row).
  interface ToolCallBlock {
    id: string;
    function: { name: string; arguments: string };
  }
  interface ToolResultBlock {
    toolCallId: string;
    content: string;
  }
  const messages: Array<Record<string, unknown>> = [];
  let openCalls = new Map<string, { name: string; input: unknown }>();

  for (const m of rows) {
    if (m.role === 'assistant') {
      // The column holds EITHER the row's tool calls (an array) or display
      // blocks (an envelope) — a guard-rail ending has no tool calls.
      const calls = Array.isArray(m.contentBlocks) ? (m.contentBlocks as unknown as ToolCallBlock[]) : [];
      const blocks = Array.isArray(m.contentBlocks) ? [] : normalizeBlocks(m.contentBlocks);
      openCalls = new Map(
        calls.map((c) => {
          let input: unknown = {};
          try {
            input = JSON.parse(c.function.arguments || '{}');
          } catch {
            // keep {}
          }
          return [c.id, { name: c.function.name, input }];
        }),
      );
      if (m.content || blocks.length > 0) {
        messages.push({
          role: 'assistant',
          content: m.content,
          ...(blocks.length > 0 ? { blocks } : {}),
          createdAt: m.createdAt,
        });
      }
      continue;
    }
    if (m.role === 'tool') {
      for (const r of (m.contentBlocks as ToolResultBlock[] | null) ?? []) {
        const call = openCalls.get(r.toolCallId);
        if (!call) continue;
        messages.push({
          role: 'tool',
          content: '',
          tool: { name: call.name, input: call.input, result: r.content?.slice(0, 2000) },
          createdAt: m.createdAt,
        });
      }
      continue;
    }
    messages.push({
      role: m.role,
      content: m.content,
      authorId: m.authorId,
      pageContext: m.pageContext,
      createdAt: m.createdAt,
      // Automatism rows — and server-written cancel notes — carry their
      // TranslatedMessage container (i18n key + params + English fallback)
      // for per-viewer localization
      ...((m.role === 'automatism' || m.role === 'cancel') && m.contentBlocks
        ? { tm: m.contentBlocks }
        : {}),
      ...(m.role === 'user' && attachmentsByMsg.has(m.id)
        ? { attachments: attachmentsByMsg.get(m.id) }
        : {}),
      // What this message shows, as opposed to what it says (messageBlocks).
      ...(m.role === 'user' && m.contentBlocks
        ? (() => {
            const blocks = normalizeBlocks(m.contentBlocks);
            return blocks.length > 0 ? { blocks } : {};
          })()
        : {}),
      // The /command the message was sent with — rendered as a chip beside it.
      ...(m.role === 'user' && m.command ? { command: m.command } : {}),
    });
  }

  // Workflow/side state comes from the SAME builder the SSE `state` events
  // use (streamed-state plan phase 1) — snapshot and stream cannot drift.
  const state = await buildChatState(chatId);
  if (!state) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  }

  // Turn state (phase, pending question, lastError) lives IN the snapshot.
  return new Response(JSON.stringify({ state, messages }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
