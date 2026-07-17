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
      executions: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
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

  for (const m of chat.messages) {
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
    });
  }

  return new Response(
    JSON.stringify({
      phase: chat.turnPhase,
      workflowPhase: chat.workflowPhase,
      planJson: chat.planJson,
      lastError: chat.lastError,
      messages,
      // For rehydrating workspace state after reload/chat switch — without
      // these the Publish button waits forever for an execution_committed
      // event that already happened.
      executions: chat.executions.map((e) => ({
        sha: e.sha,
        summary: e.summary,
        revertedBySha: e.revertedBySha,
      })),
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
