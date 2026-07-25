/** Chat metadata and workflow control tools. */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { broadcast } from '../bus';
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

  registerTool({
    name: 'user_ui_change_language',
    description:
      "Change the connected user's interface language for this live session only. " +
      "Call this when the latest user-written message is in a supported language that differs from the current UI language.",
    schema: z.object({
      locale: z.enum(['en', 'de']).describe('The detected language: English (en) or German (de)'),
    }),
    phases: ['plan', 'execute', 'preview', 'published'],
    kinds: ['workflow', 'deployment', 'deployments'],
    execute: async ({ locale }, ctx) => {
      // Deliberate SSE-only exception: this preference must not persist or replay.
      broadcast(ctx.chatId, 'ui_language', { locale, userId: ctx.userId });
      return JSON.stringify({ ok: true, locale, persisted: false });
    },
  });

  registerTool({
    name: 'return_to_plan',
    description:
      'Return the workflow from execution to planning when the approved plan needs a material revision. ' +
      'Keeps all worktree changes. After calling this, stop the current turn.',
    schema: z.object({
      reason: z.string().min(1).describe('Why the approved plan needs to be revised'),
    }),
    phases: ['execute'],
    execute: async ({ reason }, ctx) => {
      const { returnToPlan } = await import('../workflow');
      await returnToPlan(ctx.chatId);
      // The bridge lives for the whole turn; revoke execute-only tools immediately.
      ctx.workflowPhase = 'plan';
      return JSON.stringify({ ok: true, phase: 'plan', reason });
    },
  });
}
