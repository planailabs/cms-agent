/**
 * Chat task list — the agent's own checklist, visible to the user. Written
 * while planning (what will be done) and kept current while executing (what
 * is being worked on, what is finished). Each task carries a display text for
 * the user and an optional note only the agent reads.
 */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { emitChatState } from '../chatState';
import { registerTool } from './registry';

export const TASK_STATUSES = ['todo', 'working', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Compact rendering for the system prompt — the agent's own tasks back. */
export async function taskListForPrompt(chatId: string): Promise<string | null> {
  const tasks = await prisma.chatTask.findMany({
    where: { chatId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });
  if (tasks.length === 0) return null;
  const mark = { todo: ' ', working: '~', done: 'x' };
  return tasks
    .map(
      (t) =>
        `[${mark[t.status as TaskStatus] ?? ' '}] ${t.id} ${t.text}${t.note ? ` — note: ${t.note}` : ''}`,
    )
    .join('\n');
}

export function registerTaskTools(): void {
  registerTool({
    name: 'add_tasks',
    description:
      'Add tasks to this chat\'s task list — the checklist the user watches while ' +
      'you work. Add them when the work has more than one step: while planning, ' +
      'one per plan step; while executing, whenever new work surfaces. Each task ' +
      'needs a short display text in the user\'s language, plus an optional note ' +
      'only you read (file paths, gotchas, the approach you settled on).',
    schema: z.object({
      tasks: z
        .array(
          z.object({
            text: z.string().min(1).max(200).describe('Short user-facing description.'),
            note: z
              .string()
              .max(2000)
              .optional()
              .describe('Working note for yourself — never shown to the user.'),
          }),
        )
        .min(1)
        .max(50)
        .describe('Tasks to append, in the order they will be done.'),
    }),
    phases: ['plan', 'execute'],
    execute: async ({ tasks }, ctx) => {
      const last = await prisma.chatTask.findFirst({
        where: { chatId: ctx.chatId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      let order = (last?.order ?? -1) + 1;
      const created = [];
      for (const task of tasks) {
        created.push(
          await prisma.chatTask.create({
            data: { chatId: ctx.chatId, text: task.text, note: task.note, order: order++ },
          }),
        );
      }
      emitChatState(ctx.chatId);
      return JSON.stringify({
        ok: true,
        tasks: created.map((t) => ({ id: t.id, text: t.text, status: t.status })),
      });
    },
  });

  registerTool({
    name: 'update_task',
    description:
      'Update one task: mark it working when you start it and done when it is ' +
      'finished, or correct its text/note. Keep exactly one task working at a ' +
      'time — it is what the user sees you doing right now.',
    schema: z.object({
      id: z.string().min(1).describe('Task id from add_tasks or the task list.'),
      status: z.enum(TASK_STATUSES).optional().describe('todo, working, or done.'),
      text: z.string().min(1).max(200).optional().describe('Corrected display text.'),
      note: z.string().max(2000).optional().describe('Replacement working note.'),
    }),
    phases: ['execute'],
    execute: async ({ id, status, text, note }, ctx) => {
      // updateMany scopes the write to this chat — a stray id from another
      // chat's list must not be writable from here.
      const res = await prisma.chatTask.updateMany({
        where: { id, chatId: ctx.chatId },
        data: {
          ...(status ? { status } : {}),
          ...(text ? { text } : {}),
          ...(note !== undefined ? { note } : {}),
        },
      });
      if (res.count === 0) return JSON.stringify({ error: `No task ${id} in this chat.` });
      emitChatState(ctx.chatId);
      return JSON.stringify({ ok: true, id, status, text, note });
    },
  });
}
