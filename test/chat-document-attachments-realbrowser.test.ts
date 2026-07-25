import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { ATTACHMENT_ACCEPT } from '@/components/chat/actions/chat/attachments';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('document attachment picker', () => {
  it('keeps the attachment control visible and accepts Firecrawl document formats', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<button data-attach>Attach</button><input type="file" accept="${ATTACHMENT_ACCEPT}">`);
      await expect.poll(() => page.locator('[data-attach]').isVisible()).toBe(true);
      const accept = await page.locator('input').getAttribute('accept');
      for (const extension of ['.pdf', '.doc', '.docx', '.rtf', '.odt', '.xlsx']) {
        expect(accept).toContain(extension);
      }
      await page.locator('input').setInputFiles({
        name: 'brief.rtf', mimeType: 'application/rtf', buffer: Buffer.from('{\\rtf1 brief}'),
      });
      expect(await page.locator('input').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('brief.rtf');
    } finally {
      await page.close();
    }
  });
});
