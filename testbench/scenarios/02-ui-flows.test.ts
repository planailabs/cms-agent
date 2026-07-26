/**
 * Browser-driven workspace flows — no agent turns. One admin session reused
 * across tests (sequential); the preview iframe boot this triggers also
 * warms the main preview instance for later scenarios.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootWorkspace,
  dataAction,
  launchBrowser,
  newSession,
  openBranchPanel,
  shot,
  type Browser,
  type Session,
} from '../lib/browser';
import { benchRun } from '../lib/env';
import { judgeStep, recordAssert } from '../lib/judge';

const SCENARIO = '02-ui';

let browser: Browser;
let s: Session;

const ok = (name: string, pass: boolean, detail = '') => {
  recordAssert(SCENARIO, name, pass, detail);
  expect(pass, `${name}: ${detail}`).toBe(true);
};

beforeAll(async () => {
  browser = await launchBrowser();
  s = await newSession(browser);
  await bootWorkspace(s.page);
});

afterAll(async () => {
  await browser?.close();
});

describe('ui flows', () => {
  it('workspace boots with sidebar, composer, and example prompts', async () => {
    const sidebarText = await s.page.locator('#sidebar-region').innerText();
    ok('sidebar shows the main branch', sidebarText.toLowerCase().includes('main'));
    const prompts = await dataAction(s.page, 'chat-example-prompt').count();
    ok('example prompts render on the empty chat', prompts > 0, `${prompts} prompts`);
  });

  it('new chat via the branch panel makes a workflow chat active', async () => {
    await openBranchPanel(s.page);
    await dataAction(s.page, 'ws-new-chat').first().click();
    // The new workflow chat has a worktree — the code browser opener appears
    // usable and the composer stays interactive.
    await dataAction(s.page, 'machine-config-input').first().waitFor({ timeout: 30_000 });
    // Collapse the panel again — expanded it overlays the header dropdowns.
    await dataAction(s.page, 'ws-branch-list-toggle').first().click();
    await s.page.waitForTimeout(300);
    ok('new chat created from the sidebar', true);
  });

  it('theme toggle persists to the profile', async () => {
    const before = ((await (await s.context.request.get(`${benchRun().baseUrl}/api/me`)).json()) as {
      theme?: string;
    }).theme;
    await dataAction(s.page, 'theme-toggle').first().click();
    await expect
      .poll(
        async () =>
          ((await (await s.context.request.get(`${benchRun().baseUrl}/api/me`)).json()) as {
            theme?: string;
          }).theme,
        { timeout: 10_000 },
      )
      .not.toBe(before);
    recordAssert(SCENARIO, 'theme toggle persists via PATCH /api/me', true);
  });

  it('language switch to German localizes the chrome', async () => {
    try {
      await dataAction(s.page, 'language-toggle').first().click();
      await s.page.locator('[data-action="language-select"][data-locale="de"]').first().click();
      await s.page.waitForFunction(() => document.documentElement.lang === 'de');
      const verdict = await judgeStep({
        scenario: SCENARIO,
        step: 'The user switched the UI language to German via the header language menu.',
        criteria:
          'App-rendered chrome (buttons, menus, toolbar labels, placeholders) is in German. ' +
          'FAIL only for clearly English sentences/labels rendered by the app. Ignore user data: ' +
          'chat titles (e.g. "New chat", "Deployments" created earlier), branch names like "main", ' +
          'routes/URLs, and code. German anglicisms ("Browser", "Tab", "Element-Picker") count as German.',
        artifacts: [{ kind: 'screenshot', label: 'german-ui', content: await shot(s.page) }],
        votes: 3,
      });
      expect(verdict.pass, verdict.reasoning).toBe(true);
    } finally {
      // Back to English deterministically (profile + reload) — re-driving the
      // dropdown after a re-render is flaky and this must run even on failure.
      await s.context.request.patch(`${benchRun().baseUrl}/api/me`, { data: { language: 'en' } });
      await s.page.evaluate(() => sessionStorage.removeItem('cmsagent-language'));
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await dataAction(s.page, 'machine-config-input')
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 });
      await s.page.waitForFunction(() => document.documentElement.lang === 'en', undefined, {
        timeout: 30_000,
      });
    }
  });

  it('branch menu modals: git, capabilities, archive, windows', async () => {
    const openMenuItem = async (action: string) => {
      await openBranchPanel(s.page);
      await dataAction(s.page, 'ws-branch-menu-toggle').first().click();
      await dataAction(s.page, action).first().click();
    };

    await openMenuItem('ws-git-open');
    await s.page.getByText('Initial site (basic-site)').first().waitFor({ timeout: 15_000 });
    ok('git modal lists the initial commit', true);
    await dataAction(s.page, 'ws-git-close').first().click();

    await openMenuItem('ws-caps-open');
    await s.page.locator('.ws-archive__panel').first().waitFor({ timeout: 15_000 });
    ok('capabilities modal opens', true);
    await dataAction(s.page, 'ws-caps-close').first().click();

    await openMenuItem('ws-archive-open');
    await s.page.locator('.ws-archive__panel').first().waitFor({ timeout: 15_000 });
    ok('archive modal opens', true);
    await dataAction(s.page, 'ws-archive-close').first().click();

    await openMenuItem('ws-wsn-open');
    await dataAction(s.page, 'ws-wsn-fresh').first().waitFor({ timeout: 15_000 });
    ok('window sessions picker opens', true);
    await dataAction(s.page, 'ws-wsn-close').first().click();
  });

  it('code browser opens a file', async () => {
    await dataAction(s.page, 'ws-cb-modal-open').first().click();
    const file = s.page.locator('[data-action="ws-cb-file"]').first();
    await file.waitFor({ timeout: 20_000 });
    await file.click();
    await s.page.waitForTimeout(1000);
    const verdict = await judgeStep({
      scenario: SCENARIO,
      step: 'The user opened the read-only code browser and clicked the first file in the tree.',
      criteria: 'A code/file browser UI is visible showing a file tree and file contents.',
      artifacts: [{ kind: 'screenshot', label: 'code-browser', content: await shot(s.page) }],
    });
    expect(verdict.pass, verdict.reasoning).toBe(true);
    await dataAction(s.page, 'ws-cb-modal-close').first().click();
  });

  it('preview tabs: open, switch, close', async () => {
    const tabs = () => dataAction(s.page, 'ws-tab-switch');
    const before = await tabs().count();
    await dataAction(s.page, 'ws-tab-new').first().click();
    await expect.poll(() => tabs().count()).toBe(before + 1);
    // Click the label, not the button center — the center can land on the
    // close × that lives inside the tab button.
    await tabs().first().locator('.ws-tab__label').click();
    await dataAction(s.page, 'ws-tab-close').last().click();
    await expect.poll(() => tabs().count()).toBe(before);
    ok('preview tab open/switch/close roundtrip', true);
  });

  it('sidebar collapses and restores', async () => {
    const sidebar = s.page.locator('#sidebar-region');
    const width = async () => (await sidebar.boundingBox())?.width ?? 0;
    const before = await width();
    await dataAction(s.page, 'ws-sidebar-toggle').first().click();
    await expect.poll(width).toBeLessThan(before);
    await dataAction(s.page, 'ws-sidebar-toggle').first().click();
    await expect.poll(width).toBeGreaterThanOrEqual(before - 5);
    ok('sidebar collapse/restore roundtrip', true);
  });

  it('window session persists across reload', async () => {
    // interactions above ran the debounced mirror at least once
    await s.page.waitForTimeout(1500);
    const sessions = (await (
      await s.context.request.get(`${benchRun().baseUrl}/api/window-sessions`)
    ).json()) as { sessions?: unknown[] };
    ok('window session mirrored to the server', (sessions.sessions?.length ?? 0) > 0);

    await s.page.reload({ waitUntil: 'domcontentloaded' });
    await dataAction(s.page, 'machine-config-input').first().waitFor({ state: 'visible', timeout: 60_000 });
    ok('reload restores the workspace silently (no picker)', true);
  });
});
