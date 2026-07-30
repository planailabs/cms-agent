/**
 * The /architecture tree — the diagram reference and the markdown guides that
 * used to live in docs/. Three things can silently rot: a diagram whose syntax
 * breaks (mermaid renders a red "Syntax error" box instead of failing the
 * build), prose that still cites files which have been renamed, and — because
 * the whole tree is a PUBLIC route — deployment specifics leaking into it.
 */
import { readFileSync, existsSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { CHAPTERS, SECTIONS } from '@/components/architecture';
import { GUIDES } from '@/components/architecture/guides';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const MERMAID_BUNDLE = 'node_modules/mermaid/dist/mermaid.min.js';
const PAGE_DIR = 'src/pages/architecture';
const PAGE_FILE = `${PAGE_DIR}/index.astro`;
const SHELL_FILE = 'src/components/architecture/Shell.astro';

describe('architecture page content', () => {
  it('has unique, non-empty section ids that the chapters cover exactly', () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // The table of contents renders from CHAPTERS and the body from SECTIONS —
    // a section in one and not the other is an anchor that goes nowhere.
    expect(CHAPTERS.flatMap((c) => c.sections.map((s) => s.id))).toEqual(ids);
  });

  it('every section carries prose and at least one diagram', () => {
    for (const s of SECTIONS) {
      expect(s.title.length, s.id).toBeGreaterThan(0);
      expect(s.intro.length, s.id).toBeGreaterThan(40);
      expect(s.notes.length, s.id).toBeGreaterThan(40);
      expect(s.diagrams.length, s.id).toBeGreaterThan(0);
      expect(s.source.length, s.id).toBeGreaterThan(0);
    }
  });

  it('cites files that still exist', () => {
    // This is what stops the page describing a module nobody moved it with.
    const missing = SECTIONS.flatMap((s) =>
      s.source.filter((p) => !existsSync(path.resolve(p))).map((p) => `${s.id}: ${p}`),
    );
    expect(missing).toEqual([]);
  });

  it('leaks nothing about this deployment (the whole tree is public)', () => {
    // The guides moved out of docs/ onto a public route — scan them too, so a
    // real hostname pasted into a runbook fails here instead of going live.
    const guides = GUIDES.map((g) => readFileSync(`${PAGE_DIR}/${g.slug}.md`, 'utf8')).join('\n');
    const prose =
      JSON.stringify(SECTIONS) +
      readFileSync(PAGE_FILE, 'utf8') +
      readFileSync(SHELL_FILE, 'utf8') +
      guides;
    // Runtime values and build identity are authenticated-only by policy; the
    // page may name env VARIABLES, never their values, and never read them.
    for (const forbidden of [
      /PUBLIC_GIT_COMMIT/,
      /process\.env/,
      /import\.meta\.env/,
      /@\/lib\/(env|buildInfo)/,
    ]) {
      expect(prose, `forbidden pattern ${forbidden}`).not.toMatch(forbidden);
    }

    // Documentation may name placeholder and vendor hosts; it may not name a
    // real deployment. Catches pasted URLs, which is how a real host gets in.
    const allowed =
      /^(localhost|127\.0\.0\.1|(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|localtest\.me|w3\.org)|api\.openai\.com|mcp\.context7\.com)$/;
    const hosts = [...prose.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
    expect([...new Set(hosts)].filter((h) => !allowed.test(h))).toEqual([]);
  });

  it('is a server-rendered route like every other page', () => {
    expect(readFileSync(PAGE_FILE, 'utf8')).toContain('export const prerender = false');
  });
});

describe('architecture guides', () => {
  it('every markdown page is registered, and every registration has a page', () => {
    const onDisk = readdirSync(PAGE_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    // A guide missing from GUIDES is a page the navigation never links to.
    expect(onDisk).toEqual(GUIDES.map((g) => g.slug).sort());
  });

  it('every guide renders through the shared shell with a title and lead', () => {
    for (const guide of GUIDES) {
      const src = readFileSync(`${PAGE_DIR}/${guide.slug}.md`, 'utf8');
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(src)?.[1];
      expect(frontmatter, guide.slug).toBeTruthy();
      expect(frontmatter, guide.slug).toContain('components/architecture/Shell.astro');
      // The shell prints the title; a leading H1 in the body would repeat it.
      expect(frontmatter, guide.slug).toContain(`title: ${guide.title}`);
      expect(frontmatter, guide.slug).toMatch(/\nlead: \S/);
      expect(src.slice(frontmatter!.length), guide.slug).not.toMatch(/\n# /);
    }
  });

  it('the standalone build root sees the real pages and no middleware', () => {
    // `pnpm build:architecture` ships the tree as flat HTML. It works only
    // because Astro finds no middleware under this srcDir — otherwise the auth
    // middleware (and Prisma, better-auth, the proxy addon behind it) would be
    // dragged into a build that has no adapter, database or environment.
    const link = 'site-architecture/pages/architecture';
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(link, 'index.astro'))).toBe(true);
    expect(readdirSync('site-architecture').filter((f) => f.startsWith('middleware.'))).toEqual([]);

    const config = readFileSync('astro.config.architecture.mjs', 'utf8');
    expect(config).toContain("srcDir: './site-architecture'");
    expect(config).toContain("output: 'static'");
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['build:architecture']).toContain('astro.config.architecture.mjs');
  });

  it('docs/ still resolves — it is a symlink to the route directory', () => {
    // Anything reading docs/setup.md from the repo root (README, AGENTS.md,
    // source comments) keeps working after the move.
    expect(lstatSync('docs').isSymbolicLink()).toBe(true);
    expect(readlinkSync('docs').replace(/\/$/, '')).toBe(PAGE_DIR);
    for (const guide of GUIDES) expect(existsSync(path.join('docs', `${guide.slug}.md`))).toBe(true);
  });
});

// ── Do the diagrams actually render? ─────────────────────────────────────────

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

interface DiagramCase {
  key: string;
  code: string;
}
const cases: DiagramCase[] = SECTIONS.flatMap((s) =>
  s.diagrams.map((d, i) => ({ key: `${s.id}#${i}`, code: d.code.trim() })),
);

describe('architecture page diagrams', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ chromiumSandbox: false });
    page = await browser.newPage();
    // The page ships escaped HTML inside <pre class="mermaid"> — mermaid reads
    // innerHTML and entity-decodes it, so render exactly that markup rather
    // than handing it clean strings the real page never sees.
    await page.setContent(
      cases
        .map((c) => `<pre class="mermaid" id="${c.key.replace('#', '--')}">${escapeHtml(c.code)}</pre>`)
        .join('\n'),
    );
    await page.addScriptTag({ path: MERMAID_BUNDLE });
    await page.evaluate(() => {
      const ns = (globalThis as Record<string, any>).__esbuild_esm_mermaid_nm.mermaid;
      const mermaid = ns.default ?? ns;
      (globalThis as Record<string, any>).mermaidApi = mermaid;
      mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
    });
  }, 60_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it('parses every diagram', async () => {
    const failures = await page.evaluate(async (list: DiagramCase[]) => {
      const mermaid = (globalThis as Record<string, any>).mermaidApi;
      const bad: string[] = [];
      for (const c of list) {
        try {
          await mermaid.parse(c.code);
        } catch (err) {
          bad.push(`${c.key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return bad;
    }, cases);
    expect(failures).toEqual([]);
  });

  it('renders every diagram to an svg, with no error boxes', async () => {
    // mermaid.run() is what the page itself calls; it swallows per-diagram
    // failures into a red error graphic, so inspect the DOM afterwards.
    const result = await page.evaluate(async () => {
      const mermaid = (globalThis as Record<string, any>).mermaidApi;
      try {
        await mermaid.run({ querySelector: 'pre.mermaid' });
      } catch {
        // run() rejects on the first failure; the DOM check below is the verdict
      }
      return [...document.querySelectorAll('pre.mermaid')].map((el) => ({
        key: el.id,
        processed: el.hasAttribute('data-processed'),
        svgs: el.querySelectorAll('svg').length,
        errored:
          el.querySelectorAll('[aria-roledescription="error"], .error-icon, .error-text').length,
      }));
    });

    expect(result.length).toBe(cases.length);
    expect(result.filter((r) => !r.processed || r.svgs !== 1 || r.errored > 0)).toEqual([]);
  });
});
