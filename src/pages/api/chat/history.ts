/**
 * GET /api/chat/history?chatId=… — message history for rendering.
 * Tool batches are omitted; assistant/user/cancel rows return display text.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';

export const GET: APIRoute = async ({ url }) => {
  const chatId = url.searchParams.get('chatId');
  if (!chatId) {
    return new Response(JSON.stringify({ error: 'chatId required' }), { status: 400 });
  }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      messages: { orderBy: { ordinal: 'asc' } },
    },
  });
  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  }

  const messages = chat.messages
    .filter((m) => m.role !== 'tool' && (m.role !== 'assistant' || m.content))
    .map((m) => ({
      role: m.role,
      content: m.content,
      authorId: m.authorId,
      pageContext: m.pageContext,
      createdAt: m.createdAt,
    }));

  return new Response(
    JSON.stringify({
      phase: chat.turnPhase,
      workflowPhase: chat.workflowPhase,
      planJson: chat.planJson,
      messages,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
