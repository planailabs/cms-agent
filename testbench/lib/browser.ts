/**
 * Playwright helpers for driving the booted bench server — same launch
 * pattern as the repo's *realbrowser tests (dynamic import, no sandbox).
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { benchRun } from './env';

export type { Browser, BrowserContext, Page };

export async function launchBrowser(): Promise<Browser> {
  const pw = await import('playwright');
  return pw.chromium.launch({ chromiumSandbox: false });
}

export interface Session {
  context: BrowserContext;
  page: Page;
}

/** New browser context signed in (dev-impersonated) as the given user. */
export async function newSession(browser: Browser, email = 'admin@localhost'): Promise<Session> {
  const { baseUrl } = benchRun();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const res = await context.request.post(`${baseUrl}/api/dev/impersonate`, { data: { email } });
  if (res.status() !== 200) throw new Error(`impersonate ${email}: ${res.status()}`);
  const page = await context.newPage();
  return { context, page };
}

export const dataAction = (page: Page, name: string): Locator =>
  page.locator(`[data-action="${name}"]`);

/** Load the workspace and wait until the chat composer is interactive. A
 *  fresh window may get the "continue where you left off?" offer first —
 *  start fresh in that case. */
export async function bootWorkspace(page: Page): Promise<void> {
  await page.goto(`${benchRun().baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const composer = dataAction(page, 'machine-config-input').first();
  const fresh = dataAction(page, 'ws-wsn-fresh').first();
  await composer.or(fresh).waitFor({ state: 'visible', timeout: 60_000 });
  if (await fresh.isVisible()) {
    await fresh.click();
    await composer.waitFor({ state: 'visible', timeout: 60_000 });
  }
}

/** Expand the sidebar branch panel if collapsed (new-chat/branch live there). */
export async function openBranchPanel(page: Page): Promise<void> {
  if ((await page.locator('.ws-branch-panel').count()) === 0) {
    await dataAction(page, 'ws-branch-list-toggle').first().click();
    await page.locator('.ws-branch-panel').first().waitFor({ timeout: 10_000 });
  }
}

/** Viewport screenshot as base64 (judge artifact). */
export async function shot(page: Page, fullPage = false): Promise<string> {
  const buffer = await page.screenshot({ fullPage });
  return buffer.toString('base64');
}
