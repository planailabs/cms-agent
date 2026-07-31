/**
 * `git worktree add` writes the worktree's `.git` file and only THEN checks
 * the tree out. Anything that treats "`.git` exists" as "the worktree is
 * ready" can therefore hand out an empty directory — and the preview manager
 * reads that directory to decide whether the site needs `npm install`. It
 * finds no package.json, installs nothing, and starts a dev server against a
 * node_modules that does not exist. That is how a bench run ends up with five
 * previews dying on `Cannot find module 'astro/config'`.
 *
 * The window is real but short, so this test widens it: a slow smudge filter
 * on package.json keeps the checkout busy long enough to call in the middle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';

/** Held long enough that a second caller lands mid-checkout on any machine. */
const SMUDGE_DELAY_MS = 800;

let repo: string;
let engine: typeof import('@/lib/git/engine');

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-worktree-race-'));
  repo = path.join(base, 'site');
  fs.mkdirSync(repo, { recursive: true });

  const git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', 'Init');
  await git.addConfig('user.email', 'init@example.com');
  // Checking out package.json now costs SMUDGE_DELAY_MS — the same stall a
  // large real checkout produces, without needing a large repo. Appended to
  // the config file directly: simple-git refuses to set filter.* itself.
  // The \" are git-config escapes: an unescaped quote would be stripped by
  // the config parser and the filter would silently never run.
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    `[filter "slow"]\n\tsmudge = node -e \\"setTimeout(() => process.stdin.pipe(process.stdout), ${SMUDGE_DELAY_MS})\\"\n`,
  );
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'package.json filter=slow\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"site"}\n');
  fs.writeFileSync(path.join(repo, 'astro.config.mjs'), 'export default {};\n');
  await git.add(['-A']);
  await git.commit('initial');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(base, 'var');
  resetEnvCache();
  engine = await import('@/lib/git/engine');
});

/** Resolves once git has written the worktree's `.git` — i.e. once the
 *  half-created state the fast path used to accept exists. */
const waitForDotGit = async (dir: string): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`worktree ${dir} never got a .git file`);
};

/** Content or '' — mid-checkout git may have created the file without having
 *  written it yet, which for a reader is the same as not being there. */
const readOrEmpty = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

describe('ensureWorktree concurrency', () => {
  it('never returns a worktree whose checkout is still running', async () => {
    const dir = engine.worktreeDir('c-race');
    const first = engine.ensureWorktree('c-race', 'main');

    await waitForDotGit(dir);
    // Mid-checkout on purpose: the marker the fast path keys on is there,
    // the site's manifest is not.
    expect(readOrEmpty(path.join(dir, 'package.json'))).not.toContain('"name"');

    const second = await engine.ensureWorktree('c-race', 'main');
    expect(second).toBe(dir);
    // The point of the whole test: a caller that gets a path back may read it.
    expect(readOrEmpty(path.join(second, 'package.json'))).toContain('"name"');
    expect(fs.existsSync(path.join(second, 'astro.config.mjs'))).toBe(true);

    await first;
  }, 30_000);

  it('takes the fast path once the checkout has finished', async () => {
    const dir = await engine.ensureWorktree('c-done', 'main');
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
    // Same answer without going near git again (no creation is in flight).
    expect(await engine.ensureWorktree('c-done', 'main')).toBe(dir);
  }, 30_000);
});
