/**
 * The /architecture page. Two things can silently rot here: a diagram whose
 * syntax breaks (mermaid renders a red "Syntax error" box instead of failing
 * the build), and prose that still describes files which have been renamed.
 * Both are checked. The page is also PUBLIC, so a third check makes sure no
 * deployment specifics found their way into it.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { CHAPTERS, SECTIONS } from '@/components/architecture';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const MERMAID_BUNDLE = 'node_modules/mermaid/dist/mermaid.min.js';
const PAGE_FILE = 'src/pages/architecture.astro';

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

  it('leaks nothing about this deployment (the route is public)', () => {
    const prose = JSON.stringify(SECTIONS) + readFileSync(PAGE_FILE, 'utf8');
    // Runtime values and build identity are authenticated-only by policy; the
    // page may name env VARIABLES, never their values, and never read them.
    for (const forbidden of [
      /PUBLIC_GIT_COMMIT/,
      /process\.env/,
      /import\.meta\.env/,
      /@\/lib\/(env|buildInfo)/,
      /https?:\/\/(?!(www\.)?w3\.org)[a-z0-9.-]+/i, // no concrete hosts
    ]) {
      expect(prose, `forbidden pattern ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('is a server-rendered route like every other page', () => {
    expect(readFileSync(PAGE_FILE, 'utf8')).toContain('export const prerender = false');
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
