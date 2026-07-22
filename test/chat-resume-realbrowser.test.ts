import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { renderChatComposer } from '@/components/chat/ui/chat/composer';
import { locales } from '@/components/chat/content';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('interrupted conversation recovery', () => {
  it('renders a visible resume button for restored resumable work', async () => {
    const locale = locales.en;
    const html = renderChatComposer(
      {
        phase: 'idle',
        messages: [{ role: 'user', content: 'Continue this work' }],
        canContinue: true,
      },
      locale,
      locale.chatMode,
    );
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const resume = page.locator('[data-action="chat-continue"]');
      await expect.poll(() => resume.isVisible()).toBe(true);
      await expect.poll(() => resume.textContent()).toMatch(/continue/i);
    } finally {
      await page.close();
    }
  });
});
