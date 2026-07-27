import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { createInitialState } from '@/components/chat/app/state';
import { locales } from '@/components/chat/content';
import { renderMessageBubbles } from '@/components/chat/ui/chat/bubbles';
import { renderSettingsOverlay } from '@/components/chat/ui/settingsOverlay';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('communication mode UI', () => {
  it('shows the preference and only exposes tool calls in technical mode', async () => {
    const state = createInitialState();
    state.isSettingsOverlayOpen = true;
    state.user = { id: 'u1', name: 'User', email: 'user@example.com', role: 'editor' };
    const settings = renderSettingsOverlay({ state, locale: locales.en });
    const chat = {
      phase: 'idle' as const,
      messages: [
        {
          role: 'tool' as const,
          content: '',
          tool: { name: 'read_file', input: { path: 'index.astro' }, result: 'contents' },
        },
      ],
    };

    const page = await browser.newPage();
    try {
      await page.setContent(`
        ${settings}
        <div id="non-technical">${renderMessageBubbles(chat, [], false)}</div>
        <div id="technical">${renderMessageBubbles(chat, [], true)}</div>
      `);
      const selector = page.locator('[data-action="communication-mode"]');
      await expect.poll(() => selector.isVisible()).toBe(true);
      expect(await selector.inputValue()).toBe('default');
      expect(await selector.locator('option').count()).toBe(3);
      expect(await page.locator('#non-technical details').count()).toBe(0);
      // Tool calls render as a group <details> wrapping per-call <details>
      await expect.poll(() => page.locator('#technical details.chat-tools').isVisible()).toBe(true);
      await expect.poll(() => page.locator('#technical code').textContent()).toBe('read_file');
    } finally {
      await page.close();
    }
  });
});
