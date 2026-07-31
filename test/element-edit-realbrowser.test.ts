import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { bundleInjected, MODULE_GLOBAL } from '@/lib/injected/bundle';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('element edit', () => {
  it('highlights the element behind the comment tool', async () => {
    const source = await bundleInjected('module');
    const page = await browser.newPage();
    try {
      await page.setContent('<main><button id="target">Comment here</button></main>');
      await page.evaluate(
        ({ source, globalName }) => {
          const handlers: Record<string, (data: Record<string, unknown>) => void> = {};
          const exported = new Function(
            `"use strict";${source}; return typeof ${globalName} !== "undefined" ? ${globalName} : undefined;`,
          )() as ((agent: unknown) => void) | { default: (agent: unknown) => void };
          const factory = typeof exported === 'function' ? exported : exported.default;
          const posts: Array<Record<string, unknown>> = [];
          factory({
            origin: location.origin,
            post: (message: Record<string, unknown>) => posts.push(message),
            on: (type: string, handler: (data: Record<string, unknown>) => void) => {
              handlers[type] = handler;
            },
            onTeardown: () => {},
            safe: (fn: (...args: unknown[]) => unknown) => fn,
          });
          (window as unknown as { editTest: typeof handlers & { posts?: typeof posts } }).editTest =
            Object.assign(handlers, { posts });
          handlers['cms:edit-start']({ tool: 'comment' });
        },
        { source, globalName: MODULE_GLOBAL },
      );

      await page.locator('#target').hover();
      const highlight = page.locator('.cms-ov-hl');
      await expect.poll(() => highlight.isVisible()).toBe(true);
      expect(await highlight.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        'rgba(0, 0, 0, 0)',
      );

      await page.locator('#target').click();
      await page.locator('.cms-ov-edit-input input').fill('First comment');
      await page.locator('.cms-ov-edit-input input').press('Enter');
      await page.evaluate(() => {
        const handlers = (window as unknown as { editTest: Record<string, (data: Record<string, unknown>) => void> })
          .editTest;
        handlers['cms:edit-tool']({ tool: 'cursor' });
      });

      const edit = page.getByRole('button', { name: 'Edit comment' });
      await expect.poll(() => edit.isVisible()).toBe(true);
      await edit.click();
      const input = page.locator('.cms-ov-edit-input input');
      expect(await input.inputValue()).toBe('First comment');
      await input.fill('Updated comment');
      await input.press('Enter');

      const text = await page.evaluate(() => {
        const posts = (
          window as unknown as {
            editTest: { posts: Array<{ type: string; annotations?: { comments: Array<{ text: string }> } }> };
          }
        ).editTest.posts;
        return posts.findLast((message) => message.type === 'cms:edit-changed')?.annotations?.comments[0]
          ?.text;
      });
      expect(text).toBe('Updated comment');
    } finally {
      await page.close();
    }
  });
});
