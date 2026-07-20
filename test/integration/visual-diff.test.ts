/**
 * Visual diff integration: edits a page on a branch, boots main + branch
 * previews, and verifies the screenshot diff detects changed regions.
 * Requires Playwright browsers (PLAYWRIGHT_BROWSERS_PATH on NixOS — see
 * docs/setup.md); skipped when chromium can't launch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';

const ROOT = path.resolve(__dirname, '..', '..');

let available = true;
try {
  const { chromium } = await import('playwright');
  const probe = await chromium.launch();
  await probe.close();
} catch {
  available = false;
}

let manager: typeof import('@/lib/preview/manager');

describe.skipIf(!available)('visual diff', () => {
  beforeAll(async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-vdiff-'));
    const repo = path.join(base, 'site');
    fs.cpSync(path.join(ROOT, 'examples', 'basic-site'), repo, { recursive: true });

    const git = simpleGit(repo);
    await git.init(['--initial-branch=main'] as never);
    await git.addConfig('user.name', 'T');
    await git.addConfig('user.email', 't@t');
    await git.add(['-A']);
    await git.commit('init');

    process.env.REPO_PATH = repo;
    process.env.VAR_DIR = path.join(base, 'var');
    // Default REPO_DEV_COMMAND (npx astro dev): host paths are invisible in
    // the jail — the manager installs the site's deps into the worktree.
    delete process.env.REPO_DEV_COMMAND;
    resetEnvCache();
    manager = await import('@/lib/preview/manager');

    const { ensureWorktree, commitExecution } = await import('@/lib/git/engine');
    const wt = await ensureWorktree('vdiff-branch');
    fs.writeFileSync(
      path.join(wt, 'src', 'pages', 'about.astro'),
      `<html><body><h1 style="background:#f00;color:#fff">Totally new About</h1></body></html>`,
    );
    await commitExecution('vdiff-branch', 'change about', { name: 'T', email: 't@t' });
  }, 120_000);

  afterAll(async () => {
    await manager?.shutdownAll();
  });

  it('detects changed regions on the edited page', async () => {
    const { diffRoute } = await import('@/lib/diff/screenshot');
    const result = await diffRoute('vdiff-branch', '/about/');

    expect(result.changedPixels).toBeGreaterThan(1000);
    for (const file of Object.values(result.files)) {
      expect(fs.existsSync(file)).toBe(true);
    }

    // Content markers captured next to before/after shots (compare modes)
    for (const kind of ['before', 'after'] as const) {
      const doc = JSON.parse(fs.readFileSync(`${result.files[kind]}.markers.json`, 'utf8')) as {
        h: number;
        m: Array<{ k: string; y: number }>;
      };
      expect(doc.h).toBeGreaterThan(0);
      expect(doc.m.length).toBeGreaterThan(0);
      expect(doc.m[0]).toMatchObject({ k: expect.any(String), y: expect.any(Number) });
    }

    // Cached on second call (same shas) — no new screenshots needed
    const again = await diffRoute('vdiff-branch', '/about/');
    expect(again.changedPixels).toBe(result.changedPixels);
  }, 240_000);

  it('single-flights concurrent requests for the same uncached pair', async () => {
    const { diffRoute } = await import('@/lib/diff/screenshot');
    // '/' is uncached here — without single-flight, parallel runs interleave
    // writes into the same PNGs and pngjs throws mid-read.
    const results = await Promise.all([
      diffRoute('vdiff-branch', '/'),
      diffRoute('vdiff-branch', '/'),
      diffRoute('vdiff-branch', '/'),
    ]);
    expect(results[1]).toBe(results[0]); // the SAME promise result object
    expect(results[2].changedPixels).toBe(results[0].changedPixels);
  }, 240_000);
});
