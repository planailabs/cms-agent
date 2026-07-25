import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { renderMarkdown } from '@/components/chat/utils/markdown';
import { createInitialState } from '@/components/chat/app/state';
import { renderCodeBrowser } from '@/components/workspace/codeBrowser';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('chat code links in a real browser', () => {
  it('renders /work links as visible in-app code links', async () => {
    const css = readFileSync('src/components/chat/style.css', 'utf8');
    const html = renderMarkdown('[index.astro](/work/src/pages/%5Blang%5D/index.astro:93)');
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>${css}</style><div class="chat-markdown">${html}</div>`);
      const link = page.locator('[data-action="chat-code-link"]');
      const icon = link.locator('svg');

      expect(await link.getAttribute('href')).toBe('/work/src/pages/%5Blang%5D/index.astro:93');
      expect(await link.getAttribute('target')).toBeNull();
      await expect.poll(() => link.evaluate((el) => getComputedStyle(el).display)).toBe('inline-flex');
      await expect.poll(() => icon.isVisible()).toBe(true);
      await expect.poll(() => icon.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it('shows copy and download actions for an open code-browser file', async () => {
    const state = createInitialState();
    state.activeChatId = 'chat';
    state.workspace.codeBrowser.open = true;
    state.workspace.codeBrowser.filePath = 'src/pages/index.astro';
    state.workspace.codeBrowser.fileLines = ['<h1>Hello</h1>'];
    const page = await browser.newPage();
    try {
      await page.setContent(renderCodeBrowser(state));
      const copy = page.locator('[data-action="ws-cb-copy"]');
      const download = page.locator('a[download]');
      await expect.poll(() => copy.isVisible()).toBe(true);
      await expect.poll(() => download.isVisible()).toBe(true);
      expect(await download.getAttribute('href')).toContain('mode=download');
    } finally {
      await page.close();
    }
  });
});
