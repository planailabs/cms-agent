/**
 * Orphan sweeper: leftovers of deleted chats go, everything with a live owner
 * stays — including the pooled spare branch, which has no chat on purpose.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  reserved: [] as string[],
  instances: [] as Array<{ branch: string }>,
  removeWorktree: vi.fn(async (_branch: string) => {}),
  deleteBranch: vi.fn(async (_branch: string) => {}),
  stopInstance: vi.fn(async (_branch: string) => {}),
}));

vi.mock('@/lib/git/engine', () => ({
  defaultBranch: async () => 'main',
  removeWorktree: mocks.removeWorktree,
  deleteBranch: mocks.deleteBranch,
}));
vi.mock('@/lib/preview/manager', () => ({
  stopInstance: mocks.stopInstance,
  clearStartError: vi.fn(),
  // Reclaiming a checkout drops the branch's dev-server log buffer with it.
  clearPreviewLogs: vi.fn(),
  listInstances: () => mocks.instances,
}));
vi.mock('@/lib/preview/prewarm', () => ({ reservedBranches: () => mocks.reserved }));

// Own VAR_DIR: the sweeper deletes directories, so it must never point at a
// real one (a developer's ./var, the bench's workdir).
const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-sweeper-'));
process.env.VAR_DIR = varDir;

import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { sweepOrphans } from '@/lib/worktreeCleanup';

resetEnvCache();
const worktrees = path.join(varDir, 'worktrees');
const homes = path.join(varDir, 'sandbox', 'home');
const mk = (dir: string, name: string): string => {
  const full = path.join(dir, name);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'marker'), 'x');
  return full;
};

const ACTOR = { id: 'sweeper-user', name: 'Sweeper', email: 'sweep@example.com' };
let liveChatId: string;

beforeAll(async () => {
  await prisma.chat.deleteMany({ where: { workBranch: { startsWith: 'c-a5a5' } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  const user = await prisma.user.create({ data: ACTOR });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: user.id },
  });
  const chat = await prisma.chat.create({
    data: { branchId: branch.id, workBranch: 'c-a5a500000001', createdById: user.id },
  });
  liveChatId = chat.id;
});

afterAll(async () => {
  await prisma.chat.deleteMany({ where: { workBranch: { startsWith: 'c-a5a5' } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  fs.rmSync(varDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each case starts from an empty disk — removeWorktree is mocked, so real
  // directories would otherwise survive into the next sweep.
  fs.rmSync(worktrees, { recursive: true, force: true });
  fs.rmSync(homes, { recursive: true, force: true });
  mocks.reserved = [];
  mocks.instances = [];
  mocks.removeWorktree.mockClear();
  mocks.deleteBranch.mockClear();
  mocks.stopInstance.mockClear();
});

describe('orphan sweeper', () => {
  it('removes what no chat owns and keeps what something does', async () => {
    // Work branches are `c-<hex>`; readable names below stand for real
    // branches, which the sweeper must treat differently.
    mk(worktrees, 'c-a5a500000001'); // a live chat's work branch
    mk(worktrees, 'main'); // the default branch
    mk(worktrees, 'c-a5a500000002'); // chat deleted → leftovers
    mk(worktrees, 'c-a5a500000003'); // warm pool
    mk(worktrees, 'c-a5a500000004'); // preview running right now
    mocks.reserved = ['c-a5a500000003'];
    mocks.instances = [{ branch: 'c-a5a500000004' }];

    const removed = await sweepOrphans();

    expect(removed.worktrees).toContain('c-a5a500000002');
    for (const kept of ['c-a5a500000001', 'main', 'c-a5a500000003', 'c-a5a500000004']) {
      expect(removed.worktrees).not.toContain(kept);
    }
    // Removing means the whole branch's data, not just the directory.
    expect(mocks.stopInstance).toHaveBeenCalledWith('c-a5a500000002');
    expect(mocks.removeWorktree).toHaveBeenCalledWith('c-a5a500000002');
    expect(mocks.deleteBranch).toHaveBeenCalledWith('c-a5a500000002');
  });

  it('sweeps sandbox homes by branch AND by chat id', async () => {
    const orphanHome = mk(homes, 'cms-sweep-dead-chat-id'); // chat-id keyed
    mk(homes, liveChatId); // live chat's own home
    mk(homes, 'c-a5a500000001'); // live branch's home
    mk(homes, 'default'); // ownerless fallback key

    const removed = await sweepOrphans();

    expect(removed.homes).toContain('cms-sweep-dead-chat-id');
    expect(fs.existsSync(orphanHome)).toBe(false);
    expect(removed.homes).not.toContain(liveChatId);
    expect(removed.homes).not.toContain('c-a5a500000001');
    expect(removed.homes).not.toContain('default');
    expect(fs.existsSync(path.join(homes, liveChatId))).toBe(true);
  });

  it('reclaims a stray real branch but never deletes its git ref', async () => {
    // A branch pushed to the repo before syncBranchesFromRepo noticed it: the
    // checkout is regenerable, the commits are not.
    mk(worktrees, 'feature-from-git');
    mk(worktrees, 'c-a5a500000005');

    const removed = await sweepOrphans();

    expect(removed.worktrees).toEqual(
      expect.arrayContaining(['feature-from-git', 'c-a5a500000005']),
    );
    expect(mocks.removeWorktree).toHaveBeenCalledWith('feature-from-git');
    expect(mocks.deleteBranch).toHaveBeenCalledWith('c-a5a500000005');
    expect(mocks.deleteBranch).not.toHaveBeenCalledWith('feature-from-git');
  });

  it('keeps sweeping after one entry fails', async () => {
    mk(worktrees, 'c-a5a500000006');
    mk(worktrees, 'c-a5a500000007');
    mocks.removeWorktree.mockImplementation(async (branch: string) => {
      if (branch === 'c-a5a500000006') throw new Error('worktree is locked');
    });

    const removed = await sweepOrphans();

    expect(removed.worktrees).toContain('c-a5a500000007');
    expect(removed.worktrees).not.toContain('c-a5a500000006');
  });
});
