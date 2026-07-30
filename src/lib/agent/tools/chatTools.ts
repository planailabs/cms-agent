/** Chat metadata and workflow control tools. */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { broadcast } from '../bus';
import { emitChatState } from '../chatState';
import { registerTool } from './registry';
import { planSchema } from './clientTools';
import { ALL_PHASES } from '../types';

export function registerChatTools(): void {
  registerTool({
    name: 'set_chat_title',
    description:
      "Set this chat's short title, shown in the chat list. Use a concise 3–6 word " +
      "summary of the user's goal, in the user's language. Call it once, early.",
    schema: z.object({
      title: z.string().min(1).max(80).describe('The new chat title (3–6 words)'),
    }),
    phases: ALL_PHASES,
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
    phases: ALL_PHASES,
    kinds: ['workflow', 'deployment', 'deployments'],
    execute: async ({ locale }, ctx) => {
      // Deliberate SSE-only exception: this preference must not persist or replay.
      broadcast(ctx.chatId, 'ui_language', { locale, userId: ctx.userId });
      return JSON.stringify({ ok: true, locale, persisted: false });
    },
  });

  registerTool({
    name: 'start_execution',
    description:
      'Record your plan and start implementing it right away. This is the only way ' +
      'out of the PLAN phase — there is no approval to wait for. The plan is stored ' +
      'and shown to the user, who follows along and can ask for changes at any time. ' +
      'Call it once, when your analysis is complete; if a decision is genuinely the ' +
      "user's to make, ask_question before recording rather than planning around a guess.",
    schema: planSchema,
    phases: ['plan'],
    execute: async (plan, ctx) => {
      const { startExecution } = await import('../workflow');
      await startExecution({ chatId: ctx.chatId, actorId: ctx.userId, plan });
      // The phase on the context is the signal the tool loop watches: it ends
      // this run once the round finishes, and the handler starts an EXECUTE
      // run with the EXECUTE prompt and the write tools. Flipping it without
      // that restart would leave the agent in a PLAN run that has been told
      // to implement — with read-only tools and a read-only prompt.
      ctx.workflowPhase = 'execute';
      return JSON.stringify({ ok: true, phase: 'execute', plan });
    },
  });

  registerTool({
    name: 'open_compare',
    description:
      "Put the before/after comparison on the user's screen — the same view the eye " +
      'button in the tool rail opens. Use it when you have committed changes worth ' +
      'looking at, or when the user asks to see what changed. Optionally pick the ' +
      'view: side-by-side (live pages), scroll (synced screenshots), highlight ' +
      '(changed regions marked) or onion (before/after slider).',
    schema: z.object({
      mode: z
        .enum(['side-by-side', 'scroll', 'highlight', 'onion'])
        .optional()
        .describe('Which comparison view to show. Omit to keep the current one.'),
    }),
    phases: ['execute', 'published'],
    execute: async ({ mode }, ctx) => {
      // Live UI nudge like user_ui_change_language — no persistence, no replay.
      broadcast(ctx.chatId, 'open_compare', { mode, userId: ctx.userId, chatId: ctx.chatId });
      return JSON.stringify({ ok: true, opened: 'compare', mode: mode ?? 'unchanged' });
    },
  });

  registerTool({
    name: 'return_to_plan',
    description:
      'Return the workflow from execution to planning when the approved plan needs a material revision. ' +
      'Keeps all worktree changes. Make it the last call of the round: you continue in the PLAN phase, ' +
      'with read-only tools, and plan again from there.',
    schema: z.object({
      reason: z.string().min(1).describe('Why the approved plan needs to be revised'),
    }),
    phases: ['execute'],
    execute: async ({ reason }, ctx) => {
      const { returnToPlan } = await import('../workflow');
      await returnToPlan(ctx.chatId);
      // Same run boundary as start_execution, in the other direction: the run
      // ends here and planning resumes under the PLAN contract.
      ctx.workflowPhase = 'plan';
      return JSON.stringify({ ok: true, phase: 'plan', reason });
    },
  });
}
