import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { activeBackend, resetActiveBackend } from '@/lib/site';
import { astroBackend } from '@/lib/site/astro';
import { staticBackend } from '@/lib/site/static';
import { distFilter } from '@/lib/publish/artifact';
import { buildSystemPrompt } from '@/lib/agent/prompt';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cms-site-'));

/** Point env at a repo/backend and reset both caches. */
function useRepo(repo: string, backend?: string): void {
  process.env.REPO_PATH = repo;
  if (backend === undefined) delete process.env.SITE_BACKEND;
  else process.env.SITE_BACKEND = backend;
  resetEnvCache();
  resetActiveBackend();
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  resetEnvCache();
  resetActiveBackend();
});

describe('backend detection', () => {
  it('detects astro via config file', () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'astro.config.mjs'), 'export default {}');
    useRepo(repo);
    expect(activeBackend().id).toBe('astro');
  });

  it('detects astro via package.json dependency (zero-config repos)', () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ devDependencies: { astro: '^6' } }));
    useRepo(repo);
    expect(activeBackend().id).toBe('astro');
  });

  it('falls back to static for plain html repos and missing dirs', () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'index.html'), '<html></html>');
    useRepo(repo);
    expect(activeBackend().id).toBe('static');

    useRepo(path.join(repo, 'does-not-exist'));
    expect(activeBackend().id).toBe('static');
  });

  it('SITE_BACKEND override wins; unknown ids throw with the registered list', () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'astro.config.mjs'), 'export default {}');
    useRepo(repo, 'static');
    expect(activeBackend().id).toBe('static');

    useRepo(repo, 'nextjs');
    expect(() => activeBackend()).toThrow(/not a registered site backend.*astro.*static/);
  });

  it('caches per repo and resets via resetActiveBackend', () => {
    const astro = tmp();
    fs.writeFileSync(path.join(astro, 'astro.config.mjs'), 'export default {}');
    useRepo(astro);
    expect(activeBackend().id).toBe('astro');
    // config removed but cache holds
    fs.rmSync(path.join(astro, 'astro.config.mjs'));
    expect(activeBackend().id).toBe('astro');
    resetActiveBackend();
    expect(activeBackend().id).toBe('static');
  });
});

describe('astro backend', () => {
  it('builds the dev command with route-graph config and cleans stale dev.json', () => {
    const worktree = tmp();
    fs.mkdirSync(path.join(worktree, '.astro'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.astro', 'dev.json'), '{}');
    useRepo(worktree);

    const cmd = astroBackend.devCommand({
      worktree,
      port: 4567,
      host: '::1',
      allowedHost: 'branch.cms.example.com',
    });
    expect(cmd.argv).toEqual([
      'npx', 'astro', 'dev',
      '--config', '.astro/cms-preview.config.mjs',
      '--port', '4567',
      '--host', '::1',
    ]);
    expect(cmd.extraEnv).toEqual({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'branch.cms.example.com' });
    expect(fs.existsSync(path.join(worktree, '.astro', 'cms-preview.config.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.astro', 'dev.json'))).toBe(false);
  });

  it('honors REPO_DEV_COMMAND / REPO_BUILD_COMMAND overrides', () => {
    const worktree = tmp();
    useRepo(worktree);
    process.env.REPO_DEV_COMMAND = 'pnpm dev';
    process.env.REPO_BUILD_COMMAND = 'pnpm build';
    resetEnvCache();

    const cmd = astroBackend.devCommand({ worktree, port: 1, host: 'h', allowedHost: 'a' });
    expect(cmd.argv.slice(0, 2)).toEqual(['pnpm', 'dev']);
    expect(astroBackend.buildCommand()).toBe('pnpm build');
  });

  it('defaults the build command and requires dist/', () => {
    useRepo(tmp());
    expect(astroBackend.buildCommand()).toBe('npx astro build');

    const build = tmp();
    expect(() => astroBackend.resolveDist(build)).toThrow(/no dist/);
    fs.mkdirSync(path.join(build, 'dist'));
    expect(astroBackend.resolveDist(build)).toBe(path.join(build, 'dist'));
  });

  it('maps pages and flags dynamic routes', () => {
    expect(astroBackend.pageRoute('src/pages/index.astro')).toEqual({ route: '/', dynamic: false });
    expect(astroBackend.pageRoute('src/pages/jobs/index.md')).toEqual({ route: '/jobs/', dynamic: false });
    expect(astroBackend.pageRoute('src/pages/blog/[slug].astro')).toEqual({ route: '/blog/[slug]/', dynamic: true });
    expect(astroBackend.pageRoute('src/components/Header.astro')).toBeNull();
    expect(astroBackend.pageRoute('src/pages/style.css')).toBeNull();
    expect(astroBackend.isSiteContent('src/content/blog/x.md')).toBe(true);
    expect(astroBackend.isSiteContent('README.md')).toBe(false);
  });
});

describe('static backend', () => {
  it('serves the worktree via python http.server', () => {
    const cmd = staticBackend.devCommand({ worktree: '/w', port: 8080, host: '::1', allowedHost: 'x' });
    expect(cmd.argv).toEqual([
      'python3', '-m', 'http.server', '8080', '--bind', '::1', '--directory', '.',
    ]);
    expect(cmd.extraEnv).toBeUndefined();
  });

  it('has no build step by default; the checkout is the dist', () => {
    useRepo(tmp());
    expect(staticBackend.buildCommand()).toBeNull();
    const build = tmp();
    expect(staticBackend.resolveDist(build)).toBe(build);
  });

  it('honors an explicit REPO_BUILD_COMMAND and then expects dist/', () => {
    useRepo(tmp());
    process.env.REPO_BUILD_COMMAND = 'make site';
    resetEnvCache();
    expect(staticBackend.buildCommand()).toBe('make site');
    const build = tmp();
    expect(() => staticBackend.resolveDist(build)).toThrow(/no dist/);
    fs.mkdirSync(path.join(build, 'dist'));
    expect(staticBackend.resolveDist(build)).toBe(path.join(build, 'dist'));
  });

  it('maps html files 1:1 to routes', () => {
    expect(staticBackend.pageRoute('index.html')).toEqual({ route: '/', dynamic: false });
    expect(staticBackend.pageRoute('guides/index.html')).toEqual({ route: '/guides/', dynamic: false });
    expect(staticBackend.pageRoute('about.html')).toEqual({ route: '/about.html', dynamic: false });
    expect(staticBackend.pageRoute('style.css')).toBeNull();
    expect(staticBackend.isSiteContent('about.html')).toBe(true);
    expect(staticBackend.isSiteContent('style.css')).toBe(false);
  });
});

describe('artifact dist filter', () => {
  it('drops git metadata and node_modules from dist walks', () => {
    expect(distFilter('/x/checkout/.git')).toBe(false);
    expect(distFilter('/x/checkout/node_modules')).toBe(false);
    expect(distFilter('/x/checkout/index.html')).toBe(true);
    expect(distFilter('/x/checkout/assets/app.js')).toBe(true);
  });
});

describe('prompt framing', () => {
  const input = { phase: 'plan', branchName: 'work/x', locale: 'en' } as const;

  it('names the active backend in workflow and deployment prompts', () => {
    const astro = tmp();
    fs.writeFileSync(path.join(astro, 'astro.config.mjs'), 'export default {}');
    useRepo(astro);
    expect(buildSystemPrompt({ ...input })).toContain('an Astro website');
    expect(buildSystemPrompt({ ...input, kind: 'deployments' })).toContain('an Astro website');

    useRepo(tmp());
    const p = buildSystemPrompt({ ...input });
    expect(p).toContain('a static HTML website');
    expect(p).toContain('plain static HTML');
    expect(buildSystemPrompt({ ...input, kind: 'deployment' })).toContain('a static HTML website');
  });
});
