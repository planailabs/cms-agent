/**
 * Sync (the pull automatism) rebases the work branch onto the target, which
 * rewrites every commit. The execution rows kept the pre-rebase shas, so they
 * pointed at commits the branch no longer contained — including the one
 * publish binds, which left the chat stuck on "the work branch moved since you
 * reviewed it" forever: only git_commit writes that table, and a chat with
 * nothing left to change never calls it again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { prisma } from '@/lib/db';
import { branchSha, ensureWorktree, rebaseOnto } from '@/lib/git/engine';
import { reanchorExecutions } from '@/lib/publish/publisher';

const CHAT_ID = 'sync-exec-chat';
const WORK = 'c-syncexec';
const TARGET = 'se-main';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

let repo: string;

/** Commit `file` on `branch` through its worktree, like the agent would. */
async function commitOn(branch: string, file: string, body: string, message: string) {
  const dir = await ensureWorktree(branch, TARGET);
  fs.writeFileSync(path.join(dir, file), body);
  const git = simpleGit(dir);
  await git.addConfig('user.name', IDENTITY.name);
  await git.addConfig('user.email', IDENTITY.email);
  await git.add(['-A']);
  await git.commit(message);
  return (await git.revparse(['HEAD'])).trim();
}

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-syncexec-'));
  repo = path.join(tmp, 'site');
  fs.mkdirSync(repo);
  const git = simpleGit(repo);
  await git.init(['-b', TARGET]);
  await git.addConfig('user.name', IDENTITY.name);
  await git.addConfig('user.email', IDENTITY.email);
  fs.writeFileSync(path.join(repo, 'index.md'), '# Home\n');
  await git.add(['-A']);
  await git.commit('init');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(tmp, 'var');
  const { resetEnvCache } = await import('@/lib/env');
  resetEnvCache();

  await prisma.execution.deleteMany({ where: { chatId: CHAT_ID } });
  await prisma.chat.deleteMany({ where: { id: CHAT_ID } });
  await prisma.branch.deleteMany({ where: { name: TARGET } });
  await prisma.user.deleteMany({ where: { id: 'sync-exec-user' } });
  await prisma.user.create({
    data: { id: 'sync-exec-user', name: 'Syncer', email: 'syncer@example.com' },
  });
  const branch = await prisma.branch.create({ data: { name: TARGET } });
  await prisma.chat.create({
    data: { id: CHAT_ID, branchId: branch.id, workBranch: WORK },
  });
});

describe('executions across a sync rebase', () => {
  it('re-anchors the rows so the branch stays publishable', async () => {
    // Two chat commits on the work branch, recorded as executions.
    const first = await commitOn(WORK, 'news.md', '# News\n', 'add news');
    const second = await commitOn(WORK, 'about.md', '# About\n', 'add about');
    await prisma.execution.create({ data: { chatId: CHAT_ID, sha: first, summary: 'add news' } });
    await prisma.execution.create({ data: { chatId: CHAT_ID, sha: second, summary: 'add about' } });

    // Meanwhile the target moved — this is what makes sync rewrite history.
    await commitOn(TARGET, 'contact.md', '# Contact\n', 'target moved');

    const result = await rebaseOnto(WORK, TARGET, IDENTITY);
    expect(result.conflicts).toBeUndefined();
    const head = await branchSha(WORK);
    expect(head).not.toBe(second); // the rebase really did rewrite

    await reanchorExecutions(CHAT_ID, WORK, TARGET, head);

    const rows = await prisma.execution.findMany({
      where: { chatId: CHAT_ID },
      orderBy: { createdAt: 'asc' },
    });
    // Both rows followed their commits; none still points at a dead sha.
    expect(rows.map((r) => r.summary)).toEqual(['add news', 'add about']);
    expect(rows.some((r) => r.sha === first || r.sha === second)).toBe(false);

    // What publish binds — the newest non-reverted row — is now the head.
    // This is the assertion that fails without the fix.
    const publishable = rows.filter((r) => !r.revertedBySha);
    expect(publishable[publishable.length - 1].sha).toBe(head);
  });

  it('records the head when no row matches it', async () => {
    // A head the chat never recorded (a revert landed by hand, a merge, an
    // amended message) must still end up publishable after the sync.
    const dir = await ensureWorktree(WORK, TARGET);
    const git = simpleGit(dir);
    await git.raw(['commit', '--allow-empty', '-m', 'unrecorded tip']);
    const head = (await git.revparse(['HEAD'])).trim();

    await reanchorExecutions(CHAT_ID, WORK, TARGET, head);

    const newest = await prisma.execution.findFirst({
      where: { chatId: CHAT_ID, revertedBySha: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(newest?.sha).toBe(head);
    expect(newest?.summary).toBe(`Synced with ${TARGET}`);
  });

  it('leaves a chat that never committed alone', async () => {
    await prisma.chat.deleteMany({ where: { id: 'sync-exec-empty' } });
    const chat = await prisma.chat.create({
      data: {
        id: 'sync-exec-empty',
        branchId: (await prisma.branch.findFirstOrThrow({ where: { name: TARGET } })).id,
        workBranch: `${WORK}-empty`,
      },
    });
    await reanchorExecutions(chat.id, WORK, TARGET, await branchSha(WORK));
    // Nothing was ever reviewed here — a sync must not invent something to publish.
    expect(await prisma.execution.count({ where: { chatId: chat.id } })).toBe(0);
  });
});
