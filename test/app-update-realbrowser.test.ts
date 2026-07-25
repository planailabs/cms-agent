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
        import { checkAppVersion, startUpdateWatcher } from './src/components/workspace/appUpdate.ts';
        startUpdateWatcher();
        void checkAppVersion();
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

describe('deployment update watcher', () => {
  it('reloads stale HTML only once for the same deployed commit', async () => {
    const page = await browser.newPage();
    let pageLoads = 0;
    let versionRequests = 0;
    await page.route('http://localhost/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/version') {
        versionRequests += 1;
        return route.fulfill({ json: { commit: 'new-commit' } });
      }
      if (path === '/app.js') {
        return route.fulfill({ contentType: 'text/javascript', body: script });
      }
      pageLoads += 1;
      return route.fulfill({
        contentType: 'text/html',
        body: '<div id="app" data-git-commit="old-commit"></div><script src="/app.js"></script>',
      });
    });

    try {
      await page.goto('http://localhost/');
      await expect.poll(() => versionRequests).toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem('cmsagent-reloaded-commit')))
        .toBe('new-commit');
      await expect.poll(() => pageLoads).toBe(2);
      await page.waitForTimeout(500);
      expect(pageLoads).toBe(2);
    } finally {
      await page.close();
    }
  });
});
