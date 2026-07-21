/**
 * Preview manager integration: boots a real `astro dev` for a copy of
 * examples/basic-site, verifies HTTP readiness, the sidecar routes file
 * contract, and idle/explicit stop. No LLM or DB required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';

const ROOT = path.resolve(__dirname, '..', '..');
let varDir: string;
let manager: typeof import('@/lib/preview/manager');

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-preview-it-'));
  const repo = path.join(base, 'site');
  varDir = path.join(base, 'var');
  fs.cpSync(path.join(ROOT, 'examples', 'basic-site'), repo, { recursive: true });

  const git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', 'T');
  await git.addConfig('user.email', 't@t');
  await git.add(['-A']);
  await git.commit('init');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = varDir;
  // Default REPO_DEV_COMMAND (npx astro dev): the manager installs the site's
  // deps into each worktree inside the sandbox, then astro resolves from
  // /work/node_modules/.bin. (No borrowing this repo's node_modules — the
  // jail only exposes the worktree.)
  resetEnvCache();
  manager = await import('@/lib/preview/manager');
}, 60_000);

afterAll(async () => {
  await manager?.shutdownAll();
});

describe('preview manager', () => {
  it('boots main, serves HTTP, publishes the routes file, and stops', async () => {
    const instance = await manager.ensureInstance('main');
    expect(instance.status).toBe('ready');

    const res = await fetch(`http://127.0.0.1:${instance.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Acme Consulting');

    const routes = JSON.parse(
      fs.readFileSync(path.join(varDir, 'proxy-routes.json'), 'utf8'),
    ) as { cms: string; previews: Record<string, string> };
    expect(routes.previews.main).toBe(`127.0.0.1:${instance.port}`);

    // idempotent ensure returns the same instance
    const again = await manager.ensureInstance('main');
    expect(again.port).toBe(instance.port);

    await manager.stopInstance('main');
    const after = JSON.parse(fs.readFileSync(path.join(varDir, 'proxy-routes.json'), 'utf8'));
    expect(after.previews.main).toBeUndefined();
    expect(manager.listInstances()).toHaveLength(0);
  }, 300_000);

  it('boots a branch worktree instance with the branch content', async () => {
    const { ensureBranch, ensureWorktree } = await import('@/lib/git/engine');
    await ensureBranch('draft-x');
    const wt = await ensureWorktree('draft-x');
    fs.mkdirSync(path.join(wt, '.astro'), { recursive: true });
    fs.writeFileSync(
      path.join(wt, '.astro', 'dev.json'),
      JSON.stringify({ pid: 13, port: 44185, url: 'http://127.0.0.1:44185' }),
    );
    fs.writeFileSync(
      path.join(wt, 'src', 'pages', 'index.astro'),
      '<html><body><h1>Draft content</h1></body></html>',
    );

    const instance = await manager.ensureInstance('draft-x');
    expect(instance.status).toBe('ready');
    const res = await fetch(`http://127.0.0.1:${instance.port}/`);
    expect(await res.text()).toContain('Draft content');
    await manager.stopInstance('draft-x');
  }, 300_000);
});
