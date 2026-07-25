import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { createInitialState } from '@/components/chat/app/state';
import { renderWorkflowCards } from '@/components/chat/ui/chat/cards';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('plan card', () => {
  it('keeps its full header visible while the chat region scrolls', async () => {
    const state = createInitialState();
    state.chat = {
      aiChat: {
        phase: 'question',
        messages: [],
        clientPrompt: {
          toolName: 'propose_plan',
          input: {
            summary: 'A long implementation plan',
            risk: 'content',
            steps: Array.from({ length: 60 }, (_, i) => `Step ${i + 1}`),
          },
        },
      },
    } as never;

    const css = readFileSync('src/components/chat/style.css', 'utf8');
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<style>${css}</style><div class="ws-chat-region" style="height: 280px"><section>${renderWorkflowCards(state)}</section></div>`,
      );
      const region = page.locator('.ws-chat-region');
      const header = page.locator('[data-card="plan-approval"] .ws-card__header');
      const button = page.locator('[data-action="ws-plan-open"]');
      expect(await header.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');

      await region.evaluate((el) => {
        el.scrollTop = 600;
      });
      await expect.poll(() => button.isVisible()).toBe(true);
      await expect
        .poll(async () => {
          const [regionBox, headerBox] = await Promise.all([
            region.boundingBox(),
            header.boundingBox(),
          ]);
          const offset = (headerBox?.y ?? 0) - (regionBox?.y ?? 0);
          return offset >= 0 && offset <= 32;
        })
        .toBe(true);
    } finally {
      await page.close();
    }
  });
});
