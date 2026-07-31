/**
 * The client actually boots.
 *
 * Nothing else in the suite loads the whole entry: the unit tests import
 * modules one at a time, so a module that throws while being imported — a bad
 * top-level call, a missing browser global — takes the app down at boot with
 * every unit test still green.
 *
 * Scope, honestly: this bundles with esbuild, which resolves circular imports
 * more forgivingly than the production Vite build. A cycle that crashes in
 * production ("Cannot access X before initialization") can still boot here, so
 * cycles are guarded separately and statically — see test/import-cycles.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import type { Browser } from 'playwright';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;
let bundled = '';

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
  const result = await build({
    // The same module WorkspaceShell.astro loads in the page.
    stdin: { contents: `import '@/components/chat/main';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    alias: { '@': './src' },
    // Styles are Astro's job; here they would only need an output path.
    loader: { '.css': 'text' },
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  });
  bundled = result.outputFiles[0].text;
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe('the workspace client bundle', () => {
  it('evaluates without an initialization error', async () => {
    // Served over http rather than set as content: 127.0.0.1 is a secure
    // context with a real origin, so sessionStorage and crypto.randomUUID
    // behave as they do in the app instead of throwing harness noise.
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body><div id="app"></div><script>${bundled}</script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await page.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
