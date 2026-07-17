import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';

let repo: string;
let varDir: string;
let engine: typeof import('@/lib/git/engine');

const AUTHOR = { name: 'Test Editor', email: 'editor@example.com' };

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-git-test-'));
  repo = path.join(base, 'site');
  varDir = path.join(base, 'var');
  fs.mkdirSync(repo, { recursive: true });

  const git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', 'Init');
  await git.addConfig('user.email', 'init@example.com');
  fs.mkdirSync(path.join(repo, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'pages', 'index.astro'), '<h1>Home</h1>\n');
  await git.add(['-A']);
  await git.commit('initial');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = varDir;
  resetEnvCache();
  engine = await import('@/lib/git/engine');
});

describe('git engine', () => {
  it('validates branch names as DNS-safe labels', () => {
    expect(engine.validateBranchName('summer-update')).toBeNull();
    expect(engine.validateBranchName('Summer')).toMatch(/DNS-safe/);
    expect(engine.validateBranchName('-x')).toMatch(/DNS-safe/);
    expect(engine.validateBranchName('main')).toMatch(/reserved/);
    expect(engine.validateBranchName('v-abc123')).toMatch(/reserved/);
    expect(engine.validateBranchName('c-abc123')).toMatch(/reserved/);
    expect(engine.validateBranchName('a'.repeat(64))).toMatch(/DNS-safe/);
  });

  it('creates branch + worktree, commits one execution, diffs, reverts, merges', async () => {
    const wt = await engine.ensureWorktree('summer-update');
    expect(fs.existsSync(path.join(wt, 'src', 'pages', 'index.astro'))).toBe(true);
    expect(wt).toBe(engine.worktreeDir('summer-update'));

    // no changes → no commit
    expect(await engine.commitExecution('summer-update', 'noop', AUTHOR)).toBeNull();

    // single-commit execution over multiple file changes
    fs.writeFileSync(path.join(wt, 'src', 'pages', 'index.astro'), '<h1>New Home</h1>\n');
    fs.writeFileSync(path.join(wt, 'src', 'pages', 'about.astro'), '<h1>About</h1>\n');
    const sha = await engine.commitExecution('summer-update', 'Update home, add about', AUTHOR);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const changed = await engine.changedFiles('summer-update');
    expect(changed.sort()).toEqual(['src/pages/about.astro', 'src/pages/index.astro']);

    const log = await engine.branchLog('summer-update', 5);
    expect(log[0].message).toBe('Update home, add about');
    expect(log[0].authorName).toBe('Test Editor');

    // undo = revert commit, history preserved
    const revertSha = await engine.revertCommit('summer-update', sha!, AUTHOR);
    expect(revertSha).not.toBe(sha);
    expect(fs.readFileSync(path.join(wt, 'src', 'pages', 'index.astro'), 'utf8')).toContain('Home');
    expect(fs.existsSync(path.join(wt, 'src', 'pages', 'about.astro'))).toBe(false);
    expect((await engine.branchLog('summer-update', 5)).length).toBe(3);

    // restore the reverted version = new commit applying the old tree
    const restoreSha = await engine.restoreVersion('summer-update', sha!, undefined, AUTHOR);
    expect(restoreSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(wt, 'src', 'pages', 'about.astro'))).toBe(true);

    // merge to main with merge commit
    const mainSha = await engine.mergeInto('summer-update', 'main', AUTHOR);
    expect(mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.readFileSync(path.join(repo, 'src', 'pages', 'about.astro'), 'utf8')).toContain(
      'About',
    );

    // branch resets onto new main → no diff left
    await engine.resetBranchOnto('summer-update', 'main');
    expect(await engine.changedFiles('summer-update')).toEqual([]);

    // work-branch model: branch based on a non-main target, merged back
    await engine.ensureBranch('feature-x', 'main');
    const wt2 = await engine.ensureWorktree('c-abc123', 'feature-x');
    fs.writeFileSync(path.join(wt2, 'note.md'), 'from chat worktree\n');
    const chatSha = await engine.commitExecution('c-abc123', 'chat change', AUTHOR);
    expect(chatSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await engine.changedFiles('c-abc123', 'feature-x')).toEqual(['note.md']);
    const featSha = await engine.mergeInto('c-abc123', 'feature-x', AUTHOR);
    expect(featSha).toMatch(/^[0-9a-f]{40}$/);
    await engine.resetBranchOnto('c-abc123', 'feature-x');
    expect(await engine.changedFiles('c-abc123', 'feature-x')).toEqual([]);
    // main untouched by the feature-target merge
    expect(await engine.changedFiles('feature-x')).toEqual(['note.md']);
  });

  it('self-heals untracked-file collisions when merging (build artifacts in the target)', async () => {
    const wt = await engine.ensureWorktree('lockfile-branch');
    fs.writeFileSync(path.join(wt, 'generated.json'), '{"from":"branch"}\n');
    await engine.commitExecution('lockfile-branch', 'track generated file', AUTHOR);

    // Same path exists UNTRACKED in main's checkout (e.g. npm install artifact)
    fs.writeFileSync(path.join(repo, 'generated.json'), '{"from":"artifact"}\n');

    const sha = await engine.mergeInto('lockfile-branch', 'main', AUTHOR);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.readFileSync(path.join(repo, 'generated.json'), 'utf8')).toContain('branch');
  });

  it('parses git untracked-collision errors (and only those)', () => {
    const gitError = new Error(
      'error: The following untracked working tree files would be overwritten by merge:\n' +
        '\tpackage-lock.json\n\tsub/dir/file.txt\nPlease move or remove them before you merge.\nAborting',
    );
    expect(engine.untrackedMergeCollisions(gitError)).toEqual([
      'package-lock.json',
      'sub/dir/file.txt',
    ]);
    expect(engine.untrackedMergeCollisions(new Error('CONFLICT (content): merge conflict'))).toEqual([]);
    // path traversal from a hostile message is filtered
    const evil = new Error(
      'untracked working tree files would be overwritten by merge:\n\t../../etc/passwd\n\t/abs/path\nAborting',
    );
    expect(engine.untrackedMergeCollisions(evil)).toEqual([]);
  });
});
