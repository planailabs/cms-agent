/**
 * The site-health checkpoint as a flow step.
 *
 * Detecting a broken draft is only half of it — what has to happen next is
 * that somebody fixes it. The step therefore behaves like the merge-conflict
 * pause: the flow stops, the error lands in the chat as the agent's brief, the
 * chat is forced into EXECUTE so the agent actually has write tools, and
 * resume_automatism re-runs the check instead of trusting the fix.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidationIssue } from '@/lib/validate';

const { checkSiteHealth, ensureWorktree } = vi.hoisted(() => ({
  checkSiteHealth: vi.fn(),
  ensureWorktree: vi.fn(),
}));

// No model turn: the paused state and the transcript are what is under test.
vi.mock('@/lib/agent/handler', () => ({ handleChatMessage: vi.fn(async () => {}) }));
vi.mock('@/lib/site/health', async () => {
  const actual = await vi.importActual<typeof import('@/lib/site/health')>('@/lib/site/health');
  return { ...actual, checkSiteHealth, chatPreviewRoutes: vi.fn(async () => ['/']) };
});
vi.mock('@/lib/git/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/git/engine')>('@/lib/git/engine');
  return { ...actual, ensureWorktree };
});

import { prisma } from '@/lib/db';
import { findPausedAutomatism, resumeAutomatism } from '@/lib/automatism';
import { startSiteCheck } from '@/lib/publish/publisher';

const broken: ValidationIssue = {
  validator: 'astro-dev',
  severity: 'error',
  failureClass: 'AGENT_FIXABLE',
  message: '/blog/ fails to render (HTTP 500): Could not find ../components/Hero.astro',
};

const waitFor = async (cond: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not reached');
};

let chatId = '';

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: 'sitecheck-user' } });
  await prisma.branch.deleteMany({ where: { name: 'sitecheck-target' } });
  const user = await prisma.user.create({
    data: { id: 'sitecheck-user', name: 'S', email: 'sitecheck@example.com' },
  });
  const branch = await prisma.branch.create({
    data: { name: 'sitecheck-target', createdById: user.id },
  });
  const chat = await prisma.chat.create({
    data: {
      branchId: branch.id,
      workBranch: 'c-sitecheck',
      title: 'Site check',
      createdById: user.id,
      workflowPhase: 'plan',
    },
  });
  chatId = chat.id;
});

beforeEach(async () => {
  ensureWorktree.mockReset().mockResolvedValue('/tmp/sitecheck-worktree');
  checkSiteHealth.mockReset();
  await prisma.automatism.deleteMany({ where: { chatId } });
  await prisma.message.deleteMany({ where: { chatId } });
  await prisma.chat.update({ where: { id: chatId }, data: { workflowPhase: 'plan' } });
});

describe('the site-check step', () => {
  it('passes a healthy draft through without touching the chat', async () => {
    checkSiteHealth.mockResolvedValue([]);
    const id = await startSiteCheck(chatId, 'sitecheck-user');

    await waitFor(async () =>
      (await prisma.automatism.findUniqueOrThrow({ where: { id } })).status === 'done',
    );
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
    expect(chat.workflowPhase).toBe('plan');
    const texts = (await prisma.message.findMany({ where: { chatId } })).map((m) => m.content);
    expect(texts.some((t) => t.includes('without errors'))).toBe(true);
  });

  it('pauses on a broken draft, hands the agent the error, and gives it EXECUTE', async () => {
    checkSiteHealth.mockResolvedValue([broken]);
    await startSiteCheck(chatId, 'sitecheck-user');

    await waitFor(async () => !!(await findPausedAutomatism(chatId)));
    const paused = await findPausedAutomatism(chatId);
    expect(paused?.lastError).toContain('Hero.astro');

    // Read-only PLAN would leave the agent unable to fix what it was asked to.
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
    expect(chat.workflowPhase).toBe('execute');

    const texts = (await prisma.message.findMany({ where: { chatId } })).map((m) => m.content);
    expect(texts.some((t) => t.includes('Hero.astro'))).toBe(true);
    // The brief says how to get back into the flow.
    expect(texts.some((t) => t.includes('resume_automatism'))).toBe(true);
  });

  it('re-checks on resume instead of taking the fix on trust', async () => {
    checkSiteHealth.mockResolvedValue([broken]);
    const id = await startSiteCheck(chatId, 'sitecheck-user');
    await waitFor(async () => !!(await findPausedAutomatism(chatId)));

    // Still broken: the flow pauses again rather than completing.
    expect(await resumeAutomatism(id)).toBe(true);
    await waitFor(async () => (await prisma.automatism.findUniqueOrThrow({ where: { id } })).status === 'paused');
    expect(checkSiteHealth).toHaveBeenCalledTimes(2);

    checkSiteHealth.mockResolvedValue([]);
    expect(await resumeAutomatism(id)).toBe(true);
    await waitFor(async () => (await prisma.automatism.findUniqueOrThrow({ where: { id } })).status === 'done');
  });
});
