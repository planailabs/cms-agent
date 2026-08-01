/**
 * start_execution (shadow plan) — the agent records the plan and proceeds
 * without an approval card — and open_compare, the live UI nudge that puts
 * the before/after view on screen.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/git/engine', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureBranch: vi.fn(async () => {}),
  branchSha: vi.fn(async () => 'a'.repeat(40)),
}));

import { prisma } from '@/lib/db';
import { addConnection } from '@/lib/agent/bus';
import { registerChatTools } from '@/lib/agent/tools/chatTools';
import { registerClientTools } from '@/lib/agent/tools/clientTools';
import { executeTool, toolsForPhase } from '@/lib/agent/tools/registry';
import type { ToolContext } from '@/lib/agent/tools/registry';
import { WorkflowError, startExecution } from '@/lib/agent/workflow';

const ACTOR = { id: 'shadow-plan-user', name: 'Shadow', email: 'shadow@example.com' };
const PLAN = {
  summary: 'Fix the footer year',
  steps: ['Update the footer component'],
  files: [{ path: 'src/components/Footer.astro', action: 'modify' as const, reason: 'year' }],
  pages: [{ url: '/', expectedEffect: 'footer shows 2026' }],
  risk: 'content' as const,
};

let branchId: string;

const makeChat = (workBranch: string, data: Record<string, unknown> = {}) =>
  prisma.chat.create({
    data: { branchId, workBranch, createdById: ACTOR.id, title: 'Shadow', ...data },
  });

const ctx = (chatId: string, overrides: Partial<ToolContext> = {}): ToolContext => ({
  chatId,
  branchId,
  branchName: 'c-shadow',
  userId: ACTOR.id,
  workflowPhase: 'plan',
  chatKind: 'workflow',
  worktreePath: '',
  userContext: new Map(),
  modifiedPaths: new Set(),
  ...overrides,
});

beforeAll(async () => {
  registerClientTools();
  registerChatTools();
  await prisma.chat.deleteMany({ where: { workBranch: { startsWith: 'c-shadow' } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  const user = await prisma.user.create({ data: ACTOR });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: user.id },
  });
  branchId = branch.id;
});

describe('start_execution', () => {
  it('records the plan and moves the context to execute', async () => {
    const chat = await makeChat('c-shadow-1');
    const toolCtx = ctx(chat.id);

    const result = JSON.parse(await executeTool('start_execution', PLAN, toolCtx));
    expect(result).toMatchObject({ ok: true, phase: 'execute' });

    const after = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(after.workflowPhase).toBe('execute');
    expect(after.planJson).toMatchObject({ summary: 'Fix the footer year' });
    // The phase on the context is what ends the run: the tool loop sees it
    // change and hands the turn to a fresh EXECUTE run with the EXECUTE
    // prompt and the write tools (test/phase-run-boundary.test.ts).
    expect(toolCtx.workflowPhase).toBe('execute');

    // Audited exactly like a user approval, with the requesting user as actor.
    const approval = await prisma.approval.findFirst({
      where: { chatId: chat.id, action: 'plan' },
    });
    expect(approval?.actorId).toBe(ACTOR.id);
  });

  it('is offered in plan and rejected once execution started', async () => {
    const planTools = toolsForPhase('plan', 'workflow').map((t) => t.name);
    expect(planTools).toContain('start_execution');
    // The only way to record a plan — there is no approval variant.
    expect(planTools).not.toContain('propose_plan');
    expect(toolsForPhase('execute', 'workflow').map((t) => t.name)).not.toContain(
      'start_execution',
    );

    const chat = await makeChat('c-shadow-2', { workflowPhase: 'execute' });
    await expect(
      startExecution({ chatId: chat.id, actorId: ACTOR.id, plan: PLAN }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('open_compare', () => {
  it('broadcasts the view request to the live connection only', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const remove = addConnection('c-compare', {
      write: (event, data) => events.push({ event, data }),
    });
    try {
      const result = await executeTool(
        'open_compare',
        { mode: 'onion' },
        ctx('c-compare', { workflowPhase: 'execute' }),
      );
      expect(JSON.parse(result)).toMatchObject({ ok: true, opened: 'compare', mode: 'onion' });
      expect(events).toEqual([
        {
          event: 'open_compare',
          data: { mode: 'onion', userId: ACTOR.id, chatId: 'c-compare' },
        },
      ]);
    } finally {
      remove();
    }
  });

  it('is not offered while planning — there is nothing to compare yet', () => {
    expect(toolsForPhase('plan', 'workflow').map((t) => t.name)).not.toContain('open_compare');
    expect(toolsForPhase('execute', 'workflow').map((t) => t.name)).toContain('open_compare');
  });
});
