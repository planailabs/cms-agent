import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { createInitialState } from '@/components/chat/app/state';
import { locales } from '@/components/chat/content';
import { renderChatSection } from '@/components/chat/ui/chat';
import { renderNavigation } from '@/components/workspace/navigation';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('publish working UI', () => {
  it('shows a prominent live agent status and no manual server restart', async () => {
    const state = createInitialState();
    state.activeChatId = 'deploy-1';
    state.activeChatKind = 'deployment';
    state.chat = { aiChat: { phase: 'idle', messages: [] } } as never;
    state.workspace.automatism = {
      forChatId: 'deploy-1',
      automatismType: 'deploy:web',
      status: 'running',
      step: 1,
      steps: ['validate', 'deploy'],
      lastError: null,
    };

    const css = readFileSync('src/components/chat/style.css', 'utf8');
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<style>${css}</style>${renderChatSection(locales.en, state)}${renderNavigation('preview', '/')}`,
      );
      const status = page.locator('.chat-automatism--gate[role="status"]');
      await expect.poll(() => status.isVisible()).toBe(true);
      await expect.poll(() => status.textContent()).toContain('The agent is working: deploy');
      expect(await status.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid');
      expect(await status.locator('.ws-spinner').evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
      expect(await page.locator('[data-action="ws-nav-restart"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
