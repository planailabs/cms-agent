/**
 * GET /api/chat/history?chatId=… — message history for rendering.
 * Tool batches are omitted; assistant/user/cancel rows return display text.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { buildChatState } from '@/lib/agent/chatState';

export const GET: APIRoute = async ({ url }) => {
  const chatId = url.searchParams.get('chatId');
  if (!chatId) {
    return new Response(JSON.stringify({ error: 'chatId required' }), { status: 400 });
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  }
  const checkpoint = await prisma.message.findFirst({
    where: { chatId, role: 'compaction' },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  const rows = await prisma.message.findMany({
    where: { chatId, ...(checkpoint ? { ordinal: { gte: checkpoint.ordinal } } : {}) },
    orderBy: { ordinal: 'asc' },
  });

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
      const calls = (m.contentBlocks as ToolCallBlock[] | null) ?? [];
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
      if (m.content) {
        messages.push({ role: 'assistant', content: m.content, createdAt: m.createdAt });
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
      // Automatism rows carry their TranslatedMessage container (i18n key +
      // params + English fallback) for per-viewer localization
      ...(m.role === 'automatism' && m.contentBlocks ? { tm: m.contentBlocks } : {}),
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
