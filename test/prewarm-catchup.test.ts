/**
 * A warm spare is branched off the target when it is warmed and then waits for
 * a chat to claim it. Every publish in the meantime leaves it a commit further
 * behind, so a chat adopting it started on stale content: it edited an old
 * tree, diffed against the wrong base, and had to sync before it could publish
 * — the exact wait the warm pool exists to remove.
 *
 * Real git here rather than mocks: what matters is that the branch actually
 * moves and that the expensive part of the warm-up survives it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import { branchSha, ensureBranch, ensureWorktree } from '@/lib/git/engine';
import { catchUpWithTarget } from '@/lib/preview/prewarm';

const TARGET = 'pw-main';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

let repo: string;

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-prewarm-'));
  repo = path.join(tmp, 'site');
  fs.mkdirSync(repo);
  const git = simpleGit(repo);
  await git.init(['-b', TARGET]);
  await git.addConfig('user.name', IDENTITY.name);
  await git.addConfig('user.email', IDENTITY.email);
  fs.writeFileSync(path.join(repo, 'index.md'), '# Home\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  await git.add(['-A']);
  await git.commit('init');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(tmp, 'var');
  const { resetEnvCache } = await import('@/lib/env');
  resetEnvCache();
});

/** Commit on the target branch — what a publish does to it. */
async function publishOnTarget(file: string, message: string): Promise<void> {
  const dir = await ensureWorktree(TARGET);
  fs.writeFileSync(path.join(dir, file), `# ${file}\n`);
  const git = simpleGit(dir);
  await git.addConfig('user.name', IDENTITY.name);
  await git.addConfig('user.email', IDENTITY.email);
  await git.add(['-A']);
  await git.commit(message);
}

describe('catching a warm spare up with its target', () => {
  it('resets a stale spare forward and keeps the installed deps', async () => {
    const spare = 'c-stalespare01';
    await ensureBranch(spare, TARGET);
    const worktree = await ensureWorktree(spare, TARGET);
    // The expensive half of warming: an install that must survive the reset.
    fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'node_modules', 'marker'), 'installed');

    await publishOnTarget('launched.md', 'publish while the spare waits');
    const targetHead = await branchSha(TARGET);
    expect(await branchSha(spare)).not.toBe(targetHead);

    await catchUpWithTarget(spare, TARGET);

    expect(await branchSha(spare)).toBe(targetHead);
    // The published file is really in the adopting chat's worktree...
    expect(fs.existsSync(path.join(worktree, 'launched.md'))).toBe(true);
    // ...and node_modules (gitignored) was not swept away by the reset.
    expect(fs.readFileSync(path.join(worktree, 'node_modules', 'marker'), 'utf8')).toBe('installed');
  });

  it('leaves a spare that is already current untouched', async () => {
    const spare = 'c-currentspare';
    await ensureBranch(spare, TARGET);
    await ensureWorktree(spare, TARGET);
    const before = await branchSha(spare);

    await catchUpWithTarget(spare, TARGET);

    expect(await branchSha(spare)).toBe(before);
  });

  it('gives up quietly when the branch cannot be reset', async () => {
    // Chat creation must not fail over this: a spare that could not be caught
    // up is exactly as stale as it would have been without the attempt.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(catchUpWithTarget('c-does-not-exist', TARGET)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
