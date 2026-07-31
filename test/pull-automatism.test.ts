/**
 * 'pull' automatism (Sync) — rebases the work branch onto the target: clean
 * case completes and posts events; conflict case pauses with the repair's own
 * tools (the chat's phase is left alone) and resumes to completion.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';

vi.mock('@/lib/agent/handler', () => ({ handleChatMessage: vi.fn(async () => {}) }));
// The sync flow ends on the site-health checkpoint, which wants a running dev
// server for the branch. Rebasing is what this file is about — the checkpoint
// has test/site-check-automatism.test.ts to itself.
vi.mock('@/lib/site/health', async () => {
  const actual = await vi.importActual<typeof import('@/lib/site/health')>('@/lib/site/health');
  return { ...actual, checkSiteHealth: vi.fn(async () => []), chatPreviewRoutes: vi.fn(async () => ['/']) };
});

import { prisma } from '@/lib/db';
import { handleChatMessage } from '@/lib/agent/handler';
import { activeRepair, resumeAutomatism } from '@/lib/automatism';

let repo: string;
let engine: typeof import('@/lib/git/engine');
let publisher: typeof import('@/lib/publish/publisher');

const ACTOR = { id: 'pull-user', name: 'Pull Tester' };

const waitStatus = async (id: string, status: string, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await prisma.automatism.findUnique({ where: { id } }))?.status === status) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const row = await prisma.automatism.findUnique({ where: { id } });
  throw new Error(`automatism never reached ${status} (is ${row?.status}: ${row?.lastError})`);
};

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-pull-test-'));
  repo = path.join(base, 'site');
  fs.mkdirSync(repo, { recursive: true });
  const git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', 'Init');
  await git.addConfig('user.email', 'init@example.com');
  fs.writeFileSync(path.join(repo, 'index.md'), 'home\n');
  await git.add(['-A']);
  await git.commit('initial');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(base, 'var');
  resetEnvCache();
  engine = await import('@/lib/git/engine');
  publisher = await import('@/lib/publish/publisher');

  const stale = await prisma.chat.findMany({
    where: { workBranch: { in: ['c-pullclean', 'c-pullconf'] } },
    select: { id: true },
  });
  await prisma.automatism.deleteMany({ where: { chatId: { in: stale.map((c) => c.id) } } });
  await prisma.chat.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  await prisma.branch.deleteMany({ where: { name: 'pull-main' } });
  const u = await prisma.user.create({
    data: { id: ACTOR.id, name: ACTOR.name, email: 'pull@example.com' },
  });
  // Branch row named after the real default git branch
  await prisma.branch.create({ data: { name: 'main', createdById: u.id } }).catch(() => {});
});

describe('pull automatism (Sync)', () => {
  it('rebases the draft onto the target and completes', async () => {
    const branch = await prisma.branch.findUniqueOrThrow({ where: { name: 'main' } });
    const chat = await prisma.chat.create({
      data: { branchId: branch.id, workBranch: 'c-pullclean', createdById: ACTOR.id, title: 'Clean' },
    });
    const wt = await engine.ensureWorktree('c-pullclean');
    fs.writeFileSync(path.join(wt, 'draft.md'), 'draft\n');
    await engine.commitExecution('c-pullclean', 'draft work', ACTOR as never);

    // Target moves ahead
    fs.writeFileSync(path.join(repo, 'news.md'), 'news\n');
    const mainGit = simpleGit(repo);
    await mainGit.add(['-A']);
    await mainGit.commit('main: news');

    const id = await publisher.startPull(chat.id, ACTOR);
    await waitStatus(id, 'done');
    expect(fs.existsSync(path.join(wt, 'news.md'))).toBe(true); // rebased onto main
    const msgs = await prisma.message.findMany({ where: { chatId: chat.id } });
    expect(msgs.some((m) => m.role === 'automatism' && /Rebased the draft/.test(m.content))).toBe(true);
  });

  it('pauses on conflicts with a repair tool set, leaving the phase alone', async () => {
    const branch = await prisma.branch.findUniqueOrThrow({ where: { name: 'main' } });
    // A pending finish-execution card is the realistic sync-after-execution
    // state — the failure invocation must answer it, not refuse the turn.
    const chat = await prisma.chat.create({
      data: {
        branchId: branch.id,
        workBranch: 'c-pullconf',
        createdById: ACTOR.id,
        title: 'Conf',
        turnPhase: 'waiting_for_answer',
        pendingQuestion: { toolName: 'finish_execution', input: {} },
      },
    });
    const wt = await engine.ensureWorktree('c-pullconf');
    fs.writeFileSync(path.join(wt, 'index.md'), 'draft version\n');
    await engine.commitExecution('c-pullconf', 'draft edit', ACTOR as never);

    fs.writeFileSync(path.join(repo, 'index.md'), 'main version\n');
    const mainGit = simpleGit(repo);
    await mainGit.add(['-A']);
    await mainGit.commit('main: edit index');

    const id = await publisher.startPull(chat.id, ACTOR);
    await waitStatus(id, 'paused');
    // The chat keeps the phase the user left it in; the conflict tools come
    // from the paused step instead (lib/automatism repairTools).
    expect(
      (await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).workflowPhase,
    ).toBe('plan');
    const repair = await activeRepair(chat.id);
    expect(repair?.stepName).toBe('pull');
    expect(repair?.tools.has('list_conflicts')).toBe(true);
    expect(repair?.tools.has('git_rebase_continue')).toBe(true);
    expect(await engine.rebaseInProgress(wt)).toBe(true);
    expect(handleChatMessage).toHaveBeenCalledWith(
      ACTOR.id,
      expect.any(String),
      expect.objectContaining({ chatId: chat.id, type: 'answer' }),
    );

    // Agent resolves and finishes the rebase, then resumes
    fs.writeFileSync(path.join(wt, 'index.md'), 'resolved\n');
    let r = await engine.continueRebase('c-pullconf', ACTOR as never);
    while (r.conflicts?.length) {
      fs.writeFileSync(path.join(wt, 'index.md'), 'resolved\n');
      r = await engine.continueRebase('c-pullconf', ACTOR as never);
    }
    expect(await resumeAutomatism(id)).toBe(true);
    await waitStatus(id, 'done');
    expect(
      (await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).workflowPhase,
    ).toBe('plan');
    // Nothing to repair any more — the next turn is back on the phase tools.
    expect(await activeRepair(chat.id)).toBeNull();
  });
});
