/**
 * The deploy build gate: every publish first builds the tree the merge WOULD
 * produce and runs the dist validators over it.
 *
 * Two properties matter and are checked here:
 *  - it is the MERGED tree, not the work branch — a change that only breaks in
 *    combination with the target's changes has to be caught;
 *  - nothing moves to get it. mergePreviewCommit writes a dangling commit, so
 *    a failed validation leaves both branches exactly where they were and the
 *    retry (after the fix) re-derives the tree instead of being stuck on a
 *    merge sha that was recorded before the fix existed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { resetActiveBackend } from '@/lib/site';
import { branchSha, mergePreviewCommit } from '@/lib/git/engine';
import { prevalidateBuild } from '@/lib/publish/artifact';

const ID = { name: 'Bench', email: 'bench@example.com' };
const WORK = 'c-preval1';

let base: string;
let repo: string;
let git: ReturnType<typeof simpleGit>;
const saved = {
  repo: process.env.REPO_PATH,
  varDir: process.env.VAR_DIR,
  backend: process.env.SITE_BACKEND,
  buildCommand: process.env.REPO_BUILD_COMMAND,
};

const write = (rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};

const commitAll = async (message: string): Promise<string> => {
  await git.add(['-A']);
  await git.commit(message);
  return (await git.revparse(['HEAD'])).trim();
};

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-preval-'));
  repo = path.join(base, 'site');
  fs.mkdirSync(repo, { recursive: true });

  // No package.json, no astro config → the static backend, which has no build
  // step: the checkout IS the dist, so this exercises the gate without a jail.
  write('index.html', '<html><body><a href="/about.html">About</a></body></html>');
  write('about.html', '<html><body>About</body></html>');

  git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', ID.name);
  await git.addConfig('user.email', ID.email);
  await commitAll('init');

  // Work branch: an edit of its own. Target: an edit of its own. Neither side
  // alone is the tree that ships.
  await git.checkoutLocalBranch(WORK);
  write('contact.html', '<html><body>Contact</body></html>');
  await commitAll('add contact page');
  await git.checkout('main');
  write('imprint.html', '<html><body>Imprint</body></html>');
  await commitAll('add imprint page');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(base, 'var');
  // The static backend has no build step, so the gate reduces to the dist
  // validators and needs no jail. `astro build` under the jail is the same
  // code path with backend.buildCommand() non-null (test/integration).
  process.env.SITE_BACKEND = 'static';
  delete process.env.REPO_BUILD_COMMAND;
  resetEnvCache();
  resetActiveBackend();
});

afterAll(() => {
  process.env.REPO_PATH = saved.repo;
  process.env.VAR_DIR = saved.varDir;
  process.env.SITE_BACKEND = saved.backend;
  if (saved.buildCommand === undefined) delete process.env.REPO_BUILD_COMMAND;
  else process.env.REPO_BUILD_COMMAND = saved.buildCommand;
  resetEnvCache();
  resetActiveBackend();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('deploy pre-validation', () => {
  it('builds the merged tree without moving either branch', async () => {
    const before = { main: await branchSha('main'), work: await branchSha(WORK) };

    const preview = await mergePreviewCommit(WORK, 'main', ID);
    expect(preview).toMatch(/^[0-9a-f]{40}$/);

    // Both sides' files are in the previewed tree — that is the difference
    // between validating this and validating the work branch.
    const listed = await git.raw(['ls-tree', '--name-only', preview!]);
    expect(listed.split('\n')).toEqual(
      expect.arrayContaining(['contact.html', 'imprint.html', 'index.html']),
    );

    const log: string[] = [];
    await expect(prevalidateBuild(preview!, (l) => log.push(l))).resolves.toBeUndefined();
    expect(log.join('\n')).toContain('Pre-validation passed');

    expect(await branchSha('main')).toBe(before.main);
    expect(await branchSha(WORK)).toBe(before.work);
  });

  it('rejects a merged tree that fails the dist validators', async () => {
    await git.checkout(WORK);
    write('leak.html', '<html><body><script src="/injected-cms-agent.js"></script></body></html>');
    const bad = await commitAll('leak the CMS overlay into the site');
    await git.checkout('main');

    const preview = await mergePreviewCommit(WORK, 'main', ID);
    const log: string[] = [];
    await expect(prevalidateBuild(preview!, (l) => log.push(l))).rejects.toThrow(
      /Pre-publish validation failed/,
    );
    expect(log.join('\n')).toContain('CMS/overlay references');

    // The fix converges: the retry re-derives the tree from the fixed branch
    // instead of re-checking the sha that failed.
    await git.checkout(WORK);
    await git.raw(['revert', '--no-edit', bad]);
    await git.checkout('main');
    const retry = await mergePreviewCommit(WORK, 'main', ID);
    expect(retry).not.toBe(preview);
    await expect(prevalidateBuild(retry!, () => {})).resolves.toBeUndefined();
  });

  it('defers to the merge step when the two sides conflict', async () => {
    await git.checkout(WORK);
    write('index.html', '<html><body>work version</body></html>');
    await commitAll('rewrite index on the work branch');
    await git.checkout('main');
    write('index.html', '<html><body>target version</body></html>');
    await commitAll('rewrite index on the target');

    // Nothing to build yet — the real merge is what materializes the conflict
    // for the agent, and the merge step re-runs this check afterwards.
    expect(await mergePreviewCommit(WORK, 'main', ID)).toBeNull();
  });
});
