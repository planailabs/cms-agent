/**
 * git_commit tool: commits worktree changes, records an Execution row, and
 * leaves the worktree clean (the finish_execution gate relies on dirStatus).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { prisma } from '@/lib/db';
import { dirStatus } from '@/lib/git/engine';
import { registerCommitTools } from '@/lib/agent/tools/commitTools';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';

registerCommitTools();

let repo: string;

const CHAT_ID = 'commit-tool-chat';

function ctx(): ToolContext {
  return {
    chatId: CHAT_ID,
    branchId: 'commit-tool-branch',
    branchName: 'main',
    userId: 'commit-tool-user',
    workflowPhase: 'execute',
    chatKind: 'workflow',
    worktreePath: repo,
    userContext: new Map(),
    modifiedPaths: new Set(),
  };
}

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-commit-'));
  repo = path.join(tmp, 'site');
  fs.mkdirSync(repo);
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'index.md'), '# Home\n');
  await git.add(['-A']);
  await git.commit('init');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(tmp, 'var');
  const { resetEnvCache } = await import('@/lib/env');
  resetEnvCache();

  await prisma.execution.deleteMany({ where: { chatId: CHAT_ID } });
  await prisma.chat.deleteMany({ where: { id: CHAT_ID } });
  await prisma.branch.deleteMany({ where: { id: 'commit-tool-branch' } });
  await prisma.user.deleteMany({ where: { id: 'commit-tool-user' } });
  await prisma.user.create({
    data: { id: 'commit-tool-user', name: 'Committer', email: 'committer@example.com' },
  });
  const branch = await prisma.branch.create({ data: { id: 'commit-tool-branch', name: 'ct-main' } });
  await prisma.chat.create({
    data: { id: CHAT_ID, branchId: branch.id, workBranch: 'c-committool' },
  });
});

describe('git_commit', () => {
  it('reports a clean worktree without committing', async () => {
    const res = JSON.parse(await executeTool('git_commit', { message: 'noop change' }, ctx()));
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/clean/);
  });

  it('commits dirty changes, records an Execution row, leaves worktree clean', async () => {
    fs.writeFileSync(path.join(repo, 'about.md'), '# About\n');
    expect(await dirStatus(repo)).toEqual(['about.md']);

    const res = JSON.parse(await executeTool('git_commit', { message: 'add about page' }, ctx()));
    expect(res.success).toBe(true);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);

    expect(await dirStatus(repo)).toEqual([]);
    const row = await prisma.execution.findFirst({ where: { chatId: CHAT_ID, sha: res.sha } });
    expect(row?.summary).toBe('add about page');

    const log = await simpleGit(repo).log();
    expect(log.latest?.message).toBe('add about page');
    expect(log.latest?.author_email).toBe('committer@example.com');
  });

  it('is EXECUTE-only', async () => {
    const res = JSON.parse(
      await executeTool('git_commit', { message: 'x' }, { ...ctx(), workflowPhase: 'plan' }),
    );
    expect(res.error).toMatch(/not allowed in the plan phase/);
  });
});

describe('git_revert', () => {
  it('reverts a commit, marks its execution card, restores the file', async () => {
    fs.writeFileSync(path.join(repo, 'news.md'), '# News\n');
    const committed = JSON.parse(await executeTool('git_commit', { message: 'add news' }, ctx()));

    const res = JSON.parse(await executeTool('git_revert', { sha: committed.sha }, ctx()));
    expect(res.success).toBe(true);
    expect(res.revertSha).toMatch(/^[0-9a-f]{40}$/);

    expect(fs.existsSync(path.join(repo, 'news.md'))).toBe(false);
    expect(await dirStatus(repo)).toEqual([]);
    const row = await prisma.execution.findFirst({ where: { chatId: CHAT_ID, sha: committed.sha } });
    expect(row?.revertedBySha).toBe(res.revertSha);
  });

  it('aborts a conflicting revert and leaves the worktree clean', async () => {
    fs.writeFileSync(path.join(repo, 'index.md'), '# Home v2\n');
    const a = JSON.parse(await executeTool('git_commit', { message: 'v2 change' }, ctx()));
    if (!a.sha) throw new Error('commit v2 failed: ' + JSON.stringify(a));
    fs.writeFileSync(path.join(repo, 'index.md'), '# Home v3\n');
    const b = JSON.parse(await executeTool('git_commit', { message: 'v3 change' }, ctx()));
    if (!b.sha) throw new Error('commit v3 failed: ' + JSON.stringify(b));

    const res = JSON.parse(await executeTool('git_revert', { sha: a.sha }, ctx()));
    expect(res.error).toMatch(/Revert failed/);
    expect(await dirStatus(repo)).toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'index.md'), 'utf8')).toBe('# Home v3\n');
  });
});
