import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { bundleInjected, MODULE_GLOBAL } from '@/lib/injected/bundle';
import { createInitialState } from '@/components/chat/app/state';
import { renderContextChip } from '@/components/chat/ui/chat/cards';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('element picker', () => {
  it('explains picking and identifies the selected element by visible text', async () => {
    const source = await bundleInjected('module');
    const state = createInitialState();
    state.workspace.contextChip = {
      kind: 'element',
      context: {
        url: 'http://preview.local/',
        route: '/',
        element: { tag: 'a', text: 'Contact us' },
      },
    };
    const chip = renderContextChip(state);
    const page = await browser.newPage();
    try {
      await page.setContent('<a id="target" href="/contact">Contact us</a>');
      await page.evaluate(
        ({ source, globalName }) => {
          const handlers: Record<string, (data: Record<string, unknown>) => void> = {};
          const posts: Array<Record<string, unknown>> = [];
          const exported = new Function(
            `"use strict";${source}; return typeof ${globalName} !== "undefined" ? ${globalName} : undefined;`,
          )() as ((agent: unknown) => void) | { default: (agent: unknown) => void };
          const factory = typeof exported === 'function' ? exported : exported.default;
          factory({
            origin: location.origin,
            post: (message: Record<string, unknown>) => posts.push(message),
            on: (type: string, handler: (data: Record<string, unknown>) => void) => {
              handlers[type] = handler;
            },
            onTeardown: () => {},
            safe: (fn: (...args: unknown[]) => unknown) => fn,
          });
          (window as unknown as { pickerTest: typeof handlers & { posts?: typeof posts } }).pickerTest =
            Object.assign(handlers, { posts });
          handlers['cms:start-element-pick']({});
        },
        { source, globalName: MODULE_GLOBAL },
      );

      const help = page.locator('.cms-ov-pick-help');
      await expect.poll(() => help.isVisible()).toBe(true);
      await expect.poll(() => help.textContent()).toMatch(/click the element/i);
      await page.locator('#target').click();

      const picked = await page.evaluate(() => {
        const test = (
          window as unknown as {
            pickerTest: { posts: Array<{ type: string; element?: { text?: string } }> };
          }
        ).pickerTest;
        return test.posts.find((message) => message.type === 'cms:element');
      });
      expect(picked?.element?.text).toBe('Contact us');
      await expect.poll(() => help.count()).toBe(0);

      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), chip);
      const label = page.locator('.ws-chip__label');
      await expect.poll(() => label.isVisible()).toBe(true);
      expect(await label.textContent()).toContain('Contact us');
      expect(await label.textContent()).toContain('<a>');
    } finally {
      await page.close();
    }
  });
});
