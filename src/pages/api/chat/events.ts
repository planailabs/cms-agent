/**
 * GET /api/chat/events?chatId=… — SSE stream, ported from chat/'s events.ts.
 * Auth comes from the session cookie (same-origin EventSource sends it).
 * On connect, a pending question is replayed so the client can re-render it.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { addConnection, type SSEWriter } from '@/lib/agent/bus';
import { currentChatState } from '@/lib/agent/chatState';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';

export const GET: APIRoute = async ({ request, url, locals }) => {
  const chatId = url.searchParams.get('chatId');
  if (!chatId) {
    return new Response(JSON.stringify({ error: 'chatId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { id: true, createdById: true },
  });
  const denied = chat && (await chatAccessDenied(locals.user!, chat));
  if (denied) return denied;
  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const writer: SSEWriter = {
        write(event, data) {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // stream closed
          }
        },
      };

      const unsubscribe = addConnection(chatId, writer);

      // Connect replay: the full authoritative snapshot — including the
      // remote turn state (pending question, lastError), so no bespoke
      // replays are needed. A client that already applied this seq skips it.
      void currentChatState(chatId).then((state) => {
        if (state) writer.write('state', { type: 'state', state });
      });

      const pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clearInterval(pingInterval);
          unsubscribe();
        }
      }, 30_000);

      request.signal.addEventListener('abort', () => {
        clearInterval(pingInterval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};
