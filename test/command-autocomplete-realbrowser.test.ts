/**
 * The /command autocomplete, driven with real keystrokes in a real browser.
 *
 * The composer is a contenteditable, so caret handling is the whole problem:
 * the menu must open only while a slash-word is being typed at the start, and
 * it must own Enter while it is open — otherwise picking a command would send
 * the half-typed message underneath it.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

/**
 * The composer markup plus the module's own behaviour, wired the way
 * chatEvents wires it. Bundled from source so the test exercises the shipped
 * functions rather than a copy of their logic.
 */
async function composerPage(): Promise<Page> {
  const { build } = await import('esbuild');
  const bundle = await build({
    stdin: {
      contents: `
        import * as commands from './src/components/chat/ui/chat/commands.ts';
        window.commands = commands;
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    alias: { '@': `${process.cwd()}/src` },
  });
  const css = readFileSync('src/components/chat/style.css', 'utf8');
  const page = await browser.newPage();
  await page.setContent(`
    <style>${css}</style>
    <div class="composer-card">
      <div class="command-menu" data-command-menu hidden role="listbox"></div>
      <div class="composer-command" data-command-chip></div>
      <div class="composer-input" contenteditable="plaintext-only" id="input"></div>
    </div>
    <script>${bundle.outputFiles[0].text}</script>
    <script>
      const input = document.getElementById('input');
      input.addEventListener('input', () => {
        window.commands.syncCommandMenu(input);
        window.commands.syncComposerChip(input);
      });
      window.sent = [];
      input.addEventListener('keydown', (e) => {
        const highlighted = window.commands.activeCommandOption(input);
        if (highlighted) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            window.commands.moveCommandHighlight(input, e.key === 'ArrowDown' ? 1 : -1);
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            window.commands.applyCommand(input, highlighted);
            return;
          }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          window.sent.push(input.textContent);
        }
      });
    </script>
  `);
  return page;
}

describe('command autocomplete', () => {
  it('opens on a slash, filters, and completes into the composer', async () => {
    const page = await composerPage();
    try {
      const menu = page.locator('[data-command-menu]');
      const input = page.locator('#input');
      await input.click();

      await expect.poll(() => menu.isVisible()).toBe(false);

      await page.keyboard.type('/');
      await expect.poll(() => menu.isVisible()).toBe(true);
      expect(await page.locator('.command-option').count()).toBeGreaterThan(0);

      await page.keyboard.type('pl');
      expect(await page.locator('.command-option__name').first().textContent()).toBe('/plan');

      // A fragment matching nothing closes it again.
      await page.keyboard.type('zzz');
      await expect.poll(() => menu.isVisible()).toBe(false);
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await expect.poll(() => menu.isVisible()).toBe(true);

      // Enter belongs to the menu: it completes and does NOT send.
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual([]);
      expect(await input.textContent()).toBe('/plan ');
      await expect.poll(() => menu.isVisible()).toBe(false);

      // The chip confirms the command was understood.
      await expect.poll(() => page.locator('.command-chip').textContent()).toBe('/plan');

      // With the menu closed, Enter sends as usual.
      await page.keyboard.type('make the footer bigger');
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual([
        '/plan make the footer bigger',
      ]);
    } finally {
      await page.close();
    }
  });

  it('stays shut for a slash that is not starting a command', async () => {
    const page = await composerPage();
    try {
      const menu = page.locator('[data-command-menu]');
      await page.locator('#input').click();
      await page.keyboard.type('read /plan.md please');

      await expect.poll(() => menu.isVisible()).toBe(false);
      // ...and no chip: the server would not treat this as a command either.
      expect(await page.locator('.command-chip').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('paints the menu above the composer, not over the message', async () => {
    const page = await composerPage();
    try {
      await page.locator('#input').click();
      await page.keyboard.type('/');
      const menu = await page.locator('[data-command-menu]').boundingBox();
      const input = await page.locator('#input').boundingBox();
      expect(menu).toBeTruthy();
      expect(input).toBeTruthy();
      expect(menu!.y + menu!.height).toBeLessThanOrEqual(input!.y + 1);
    } finally {
      await page.close();
    }
  });
});
