/**
 * Rail tooltips vs. the compare flyout. Both open into the strip right of the
 * rail, so the one the pointer asked for has to win: hovering another rail
 * button while the flyout is expanded must paint its tooltip on top, and the
 * flyout's own button must not stack a second label over its menu.
 *
 * Paint order is the thing under test, so this measures pixels — computed
 * z-index says nothing about which element a browser actually draws last.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { Browser, Page } from 'playwright';
import '@/components/workspace/diffViewer'; // registers the compare window
import { renderRail } from '@/components/workspace/rail';
import { store } from '@/components/chat/app/store';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const TOOLTIP = { r: 255, g: 0, b: 255 };
const MENU = { r: 0, g: 0, b: 255 };

/**
 * Flat colours + no transitions: the pixel read is then unambiguous. The
 * stylesheet is loaded raw, so `.tooltip`'s `@apply relative …` never runs —
 * restated here, otherwise the tooltip would anchor to the page, not the
 * button, and the probe would measure empty background.
 */
const PROBE_CSS = `
  * { transition: none !important; animation: none !important; }
  .tooltip { position: relative; display: inline-flex; align-items: center; justify-content: center; }
  /* The universal selector misses pseudo-elements: kill the fade separately,
     or the screenshot catches the tooltip half-way in. */
  .ws-rail__btn::after {
    transition: none !important;
    background: rgb(255,0,255) !important;
    border-color: rgb(255,0,255) !important;
    color: transparent !important;
  }
  .ws-compare-menu { background: rgb(0,0,255) !important; border-color: rgb(0,0,255) !important; box-shadow: none !important; }
`;

let browser: Browser;

const pixelAt = async (page: Page, x: number, y: number) => {
  const shot = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const { data } = PNG.sync.read(shot);
  return { r: data[0], g: data[1], b: data[2] };
};

beforeAll(async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe('rail tooltips over the compare flyout', () => {
  let page: Page;

  beforeAll(async () => {
    const css = readFileSync('src/components/chat/style.css', 'utf8');
    store.state.activeChatId = 'chat-1';
    store.state.workspace.window = 'compare';
    store.state.workspace.diff.menuOpen = true;

    page = await browser.newPage({ viewport: { width: 700, height: 600 } });
    await page.setContent(
      `<style>${css}</style><style>${PROBE_CSS}</style>
       <div class="ws-rail">${renderRail(store.state)}</div>`,
    );
    // Tooltips are hover-only; a browser reporting otherwise would make every
    // assertion below vacuous.
    expect(
      await page.evaluate(() => matchMedia('(any-hover: hover) and (pointer: fine)').matches),
    ).toBe(true);
    expect(await page.locator('.ws-compare-menu.is-open').boundingBox()).toBeTruthy();
  });

  afterAll(async () => page?.close());

  /** Where `selector`'s tooltip sits: just right of the button, centred on it. */
  const tooltipProbe = async (selector: string) => {
    const box = (await page.locator(selector).boundingBox())!;
    const menu = (await page.locator('.ws-compare-menu').boundingBox())!;
    // 25px clears the pill's rounded left edge, whose antialiasing blends
    // whatever is underneath into the reading.
    const point = { x: Math.round(box.x + box.width + 25), y: Math.round(box.y + box.height / 2) };
    // Nothing is proven unless the probe lands where the flyout is drawn.
    expect(point.x).toBeGreaterThan(menu.x);
    expect(point.x).toBeLessThan(menu.x + menu.width);
    expect(point.y).toBeGreaterThan(menu.y);
    expect(point.y).toBeLessThan(menu.y + menu.height);
    return point;
  };

  it('draws a hovered button’s tooltip in front of the expanded flyout', async () => {
    const probe = await tooltipProbe('[data-action="settings-link"]');
    await page.hover('[data-action="settings-link"]');
    expect(await pixelAt(page, probe.x, probe.y)).toEqual(TOOLTIP);
  });

  it('drops the flyout owner’s own tooltip instead of stacking two labels', async () => {
    const probe = await tooltipProbe('[data-action="ws-compare-open"]');
    await page.hover('[data-action="ws-compare-open"]');
    expect(await pixelAt(page, probe.x, probe.y)).toEqual(MENU);
  });
});
