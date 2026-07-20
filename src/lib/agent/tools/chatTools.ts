/**
 * Chat meta tools — set_chat_title lets the agent name the chat after the
 * first request (the system prompt asks for it while the title is still the
 * default). The sidebar updates live via the chat_renamed SSE event.
 */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { emitChatState } from '../chatState';
import { registerTool } from './registry';

export function registerChatTools(): void {
  registerTool({
    name: 'set_chat_title',
    description:
      "Set this chat's short title, shown in the chat list. Use a concise 3–6 word " +
      "summary of the user's goal, in the user's language. Call it once, early.",
    schema: z.object({
      title: z.string().min(1).max(80).describe('The new chat title (3–6 words)'),
    }),
    phases: ['plan', 'execute', 'preview', 'published'],
    execute: async (input, ctx) => {
      const title = input.title.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!title) return JSON.stringify({ error: 'Title must not be empty' });
      await prisma.chat.update({ where: { id: ctx.chatId }, data: { title } });
      emitChatState(ctx.chatId);
      return JSON.stringify({ ok: true, title });
    },
  });
}
