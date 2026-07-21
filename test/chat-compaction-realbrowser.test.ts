/** Real-browser regression for the durable compaction card and progress state. */
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { renderMessageBubbles } from '@/components/chat/ui/chat/bubbles';
import { renderCompactionIndicator } from '@/components/chat/ui/chat/indicators';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('chat compaction in a real browser', () => {
  it('shows the summary card and active progress indicator', async () => {
    const card = renderMessageBubbles({
      phase: 'idle',
      messages: [{ role: 'compaction', content: '**Current state:** tests pass' }],
    });
    const indicator = renderCompactionIndicator({ phase: 'compacting', messages: [] });
    const page = await browser.newPage();
    try {
      await page.setContent(`<main>${card}${indicator}</main>`);
      const result = await page.evaluate(() => {
        const summary = document.querySelector<HTMLElement>('[data-card="compaction"]');
        const progress = [...document.querySelectorAll<HTMLElement>('main > div')].at(-1);
        return {
          summaryDisplay: summary ? getComputedStyle(summary).display : 'missing',
          summaryHeight: summary?.getBoundingClientRect().height ?? 0,
          summaryText: summary?.innerText ?? '',
          progressDisplay: progress ? getComputedStyle(progress).display : 'missing',
          progressHeight: progress?.getBoundingClientRect().height ?? 0,
          progressText: progress?.innerText ?? '',
        };
      });
      expect(result.summaryDisplay).not.toBe('none');
      expect(result.summaryHeight).toBeGreaterThan(0);
      expect(result.summaryText).toContain('Current state: tests pass');
      expect(result.progressDisplay).not.toBe('none');
      expect(result.progressHeight).toBeGreaterThan(0);
      expect(result.progressText).toContain('Compacting');
    } finally {
      await page.close();
    }
  });

  it('does not render progress outside the compacting phase', () => {
    expect(renderCompactionIndicator({ phase: 'waiting', messages: [] })).toBe('');
  });
});
