import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import type { Browser } from 'playwright';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;
let script: string;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
  const bundle = await build({
    stdin: {
      contents: `
        import { branchPreviewUrl } from './src/components/workspace/config.ts';
        window.branchPreviewUrl = branchPreviewUrl;
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  script = bundle.outputFiles[0].text;
});

afterAll(async () => browser?.close());

describe('branch preview URLs', () => {
  it('carries the configured development port', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div id="app" data-base-domain="localhost" data-scheme="http"
          data-preview-port="8080"></div>
      `);
      await page.addScriptTag({ content: script });

      const url = await page.evaluate(() =>
        (window as unknown as { branchPreviewUrl: (branch: string, route: string) => string })
          .branchPreviewUrl('draft', '/about'),
      );
      expect(url).toBe('http://draft.localhost:8080/about');
    } finally {
      await page.close();
    }
  });
});
