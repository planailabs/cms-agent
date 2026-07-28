/**
 * Chat task list: add_tasks (plan + execute) / update_task (execute), the
 * prompt rendering the agent reads back, and the sidebar list the user sees.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { registerTaskTools, taskListForPrompt } from '@/lib/agent/tools/taskTools';
import { executeTool, toolsForPhase, type ToolContext } from '@/lib/agent/tools/registry';
import { renderTaskList } from '@/components/workspace/sidebar';
import { createInitialWorkspaceState } from '@/components/workspace/state';
import type { AppState } from '@/components/chat/app/state';

const ACTOR = { id: 'task-tools-user', name: 'Tasker', email: 'tasks@example.com' };
let chatId: string;

const ctx = (phase: 'plan' | 'execute'): ToolContext => ({
  chatId,
  branchId: 'b1',
  branchName: 'c-tasks',
  userId: ACTOR.id,
  workflowPhase: phase,
  chatKind: 'workflow',
  worktreePath: '',
  userContext: new Map(),
  modifiedPaths: new Set(),
});

beforeAll(async () => {
  registerTaskTools();
  await prisma.chat.deleteMany({ where: { workBranch: 'c-tasks' } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  const user = await prisma.user.create({ data: ACTOR });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: user.id },
  });
  const chat = await prisma.chat.create({
    data: { branchId: branch.id, workBranch: 'c-tasks', createdById: user.id, title: 'Tasks' },
  });
  chatId = chat.id;
});

describe('task tools', () => {
  it('appends tasks in order and reads them back into the prompt', async () => {
    const added = JSON.parse(
      await executeTool(
        'add_tasks',
        {
          tasks: [
            { text: 'Update the footer', note: 'src/components/Footer.astro' },
            { text: 'Refresh the about page' },
          ],
        },
        ctx('plan'),
      ),
    );
    expect(added.ok).toBe(true);
    expect(added.tasks).toHaveLength(2);
    expect(added.tasks[0].status).toBe('todo');

    // A second call appends after the first batch rather than restarting.
    await executeTool('add_tasks', { tasks: [{ text: 'Check the nav' }] }, ctx('execute'));

    const prompt = (await taskListForPrompt(chatId))!;
    const lines = prompt.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Update the footer');
    expect(lines[0]).toContain('note: src/components/Footer.astro');
    expect(lines[2]).toContain('Check the nav');
    expect(lines.every((l) => l.startsWith('[ ]'))).toBe(true);
  });

  it('marks progress and refuses ids from other chats', async () => {
    const first = await prisma.chatTask.findFirstOrThrow({
      where: { chatId },
      orderBy: { order: 'asc' },
    });
    await executeTool('update_task', { id: first.id, status: 'working' }, ctx('execute'));
    expect((await taskListForPrompt(chatId))!).toContain(`[~] ${first.id}`);

    await executeTool(
      'update_task',
      { id: first.id, status: 'done', note: 'shipped as one commit' },
      ctx('execute'),
    );
    const prompt = (await taskListForPrompt(chatId))!;
    expect(prompt).toContain(`[x] ${first.id}`);
    expect(prompt).toContain('note: shipped as one commit');

    const foreign = JSON.parse(
      await executeTool('update_task', { id: 'not-my-task', status: 'done' }, ctx('execute')),
    );
    expect(foreign.error).toContain('not-my-task');
  });

  it('is addable while planning but only updatable while executing', () => {
    const plan = toolsForPhase('plan', 'workflow').map((t) => t.name);
    const execute = toolsForPhase('execute', 'workflow').map((t) => t.name);
    expect(plan).toContain('add_tasks');
    expect(plan).not.toContain('update_task');
    expect(execute).toContain('add_tasks');
    expect(execute).toContain('update_task');
    expect(toolsForPhase('published', 'workflow').map((t) => t.name)).not.toContain('add_tasks');
  });

  it('renders the list in the sidebar without leaking agent notes', () => {
    const ws = createInitialWorkspaceState();
    ws.tasks = [
      { id: 't1', text: 'Update the footer', status: 'done' },
      { id: 't2', text: 'Refresh the about page', status: 'working' },
      { id: 't3', text: 'Check the nav', status: 'todo' },
    ];
    const html = renderTaskList({ workspace: ws } as AppState);
    expect(html).toContain('Tasks 1/3');
    expect(html).toContain('ws-task is-working');
    expect(html).toContain('Refresh the about page');
    expect(html).not.toContain('note');
    expect(renderTaskList({ workspace: createInitialWorkspaceState() } as AppState)).toBe('');
  });
});
