import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import type { Browser } from 'playwright';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('transient chat UI language', () => {
  it('rerenders the live UI without writing browser storage', async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import { store } from './src/components/chat/app/store.ts';
          import { applyTransientUiLanguage } from './src/components/chat/actions/chat/transientLocale.ts';
          store.state.user = { id: 'u1' };
          store.subscribe(() => document.body.textContent = store.state.localeKey);
          window.applyTransientUiLanguage = applyTransientUiLanguage;
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
    });
    const page = await browser.newPage();
    try {
      await page.route('http://test.local/', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html lang="en"><body>en</body></html>',
        }),
      );
      await page.goto('http://test.local/');
      await page.evaluate(() => {
        crypto.randomUUID ??= () => '00000000-0000-4000-8000-000000000000';
      });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(() =>
        (
          window as unknown as {
            applyTransientUiLanguage: (locale: string, userId: string) => boolean;
          }
        ).applyTransientUiLanguage('de', 'another-user'),
      );
      expect(await page.locator('html').getAttribute('lang')).toBe('en');
      await page.evaluate(() =>
        (
          window as unknown as {
            applyTransientUiLanguage: (locale: string, userId: string) => boolean;
          }
        ).applyTransientUiLanguage('de', 'u1'),
      );

      expect(await page.locator('html').getAttribute('lang')).toBe('de');
      await expect.poll(() => page.locator('body').textContent()).toBe('de');
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
    } finally {
      await page.close();
    }
  });
});
