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
    // The branch list lives in the expandable panel; the collapsed header
    // shows the active chat, which varies with earlier scenarios' data.
    await openBranchPanel(s.page);
    const sidebarText = await s.page.locator('#sidebar-region').innerText();
    ok('branch panel lists the main branch', sidebarText.toLowerCase().includes('main'));
    await dataAction(s.page, 'ws-branch-list-toggle').first().click();
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

  it('one-click new chat from the collapsed switcher header', async () => {
    const base = benchRun().baseUrl;
    const chatCount = async () =>
      ((await (await s.context.request.get(`${base}/api/branches`)).json()) as {
        branches: { chats: unknown[] }[];
      }).branches.reduce((n, b) => n + b.chats.length, 0);
    const before = await chatCount();
    const plus = s.page.locator('.ws-switcher__new');
    ok('switcher + button visible without opening the panel', await plus.isVisible());
    await plus.click();
    await dataAction(s.page, 'machine-config-input').first().waitFor({ timeout: 30_000 });
    await expect.poll(chatCount, { timeout: 15_000 }).toBe(before + 1);
    ok('one-click chat created on the active branch', true);
  });

  it('redesign chrome: icon rail tools and compact header', async () => {
    // Icon rail: 2 stage tools + 6 registered windows + settings
    const railButtons = await s.page.locator('.ws-rail .ws-rail__btn').count();
    ok('icon rail renders all nine tools', railButtons === 9, `${railButtons} buttons`);
    await s.page.locator('.ws-rail [data-action="settings-link"]').click();
    try {
      await s.page.locator('.settings-panel').waitFor({ timeout: 10_000 });
      ok('rail settings button opens the settings overlay', true);
    } finally {
      // NOT dataAction('close-settings').first() — that resolves to the
      // fullscreen backdrop, whose click point the panel itself covers. A
      // still-open overlay would intercept every later click in the suite.
      await s.page
        .locator('.settings-close-button')
        .click({ timeout: 5_000 })
        .catch(() => s.page.keyboard.press('Escape'));
      await s.page.locator('.settings-panel').waitFor({ state: 'detached', timeout: 10_000 });
    }

    // Compact header: branch pill, version chip, initials avatar
    await s.page.locator('.app-header__branch').waitFor({ timeout: 15_000 });
    const pill = (await s.page.locator('.app-header__branch').innerText()).trim();
    ok('header branch pill shows the active branch', pill.length > 0, pill);
    const version = (await s.page.locator('.app-header__version').innerText()).trim();
    ok('header shows the version chip', version.length > 0, version);
    await s.page.locator('.avatar-initials').waitFor({ timeout: 15_000 });
    const initials = (await s.page.locator('.avatar-initials').innerText()).trim();
    ok('avatar shows user initials', /^\S{1,2}$/.test(initials), initials);

    // Composer hosts its own element-picker button (arms + disarms)
    const composerPick = s.page.locator('.composer-pick-button');
    ok('composer has the element-picker button', (await composerPick.count()) > 0);
    await composerPick.first().click();
    await expect
      .poll(() => s.page.locator('.composer-pick-button.is-active').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await composerPick.first().click();
    await expect
      .poll(() => s.page.locator('.composer-pick-button.is-active').count(), { timeout: 10_000 })
      .toBe(0);
    ok('composer picker button arms and disarms', true);
  });

  it('paste and drop stage attachments (image file, long text, dropzone)', async () => {
    const input = dataAction(s.page, 'machine-config-input').first();
    await input.waitFor({ timeout: 15_000 });
    const chipCount = () => s.page.locator('[data-attach-chips] .composer-chip').count();

    // Query + dispatch inside ONE page-side task — a store rerender can
    // replace the composer DOM between a locator resolve and its evaluate,
    // detaching the node so the event never bubbles.
    // 1) ctrl+v with an image file on the clipboard
    await s.page.evaluate(() => {
      const el = document.querySelector('[data-action="machine-config-input"]')!;
      const bytes = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      const buf = Uint8Array.from(bytes, (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([buf], 'pasted.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(chipCount, { timeout: 15_000 }).toBe(1);
    ok('pasted image becomes an attachment chip', true);

    // 2) pasting very long text becomes a text attachment, short text does not
    await s.page.evaluate(() => {
      const el = document.querySelector('[data-action="machine-config-input"]')!;
      const dt = new DataTransfer();
      dt.setData('text/plain', 'x'.repeat(5000));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(chipCount, { timeout: 15_000 }).toBe(2);
    const composerText = await input.evaluate((el) => el.textContent ?? '');
    ok('long paste becomes a chip, not composer text', !composerText.includes('xxxx'), composerText.slice(0, 40));

    // 3) drop on the composer dropzone (the drag-and-drop upload path)
    await s.page.evaluate(() => {
      const el = document.querySelector('[data-action="chat-dropzone"]')!;
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(chipCount, { timeout: 15_000 }).toBe(3);
    ok('dropped file becomes an attachment chip', true);

    // Clean the composer state for the tests that follow
    const removes = s.page.locator('[data-action="chat-attach-remove"]');
    while ((await removes.count()) > 0) await removes.first().click();
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

  it('preview page follows the workspace theme', async () => {
    // The workspace opens no preview tab by default — create one (and leave
    // it open: it warms the preview instance for later scenarios).
    await dataAction(s.page, 'ws-tab-new').first().click();
    const iframe = s.page.locator('#preview-frame-region iframe.is-active');
    await iframe.waitFor({ state: 'attached', timeout: 30_000 });
    const effective = async (): Promise<string> =>
      (await s.page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light'
        ? 'light'
        : 'dark';
    // The site page inside the active preview frame — any *.localhost preview
    // host (the active chat decides the branch); the boot page reports null
    // until the site + injected module are up.
    const frameScheme = async (): Promise<string | null> => {
      const frame = s.page.frames().find((f) => /https?:\/\/[^/]*\.localhost:/.test(f.url()));
      if (!frame) return null;
      try {
        return await frame.evaluate(() => document.documentElement.style.colorScheme || null);
      } catch {
        return null;
      }
    };
    // First boot of the site preview may install its deps — be generous.
    try {
      await expect.poll(frameScheme, { timeout: 300_000 }).toBe(await effective());
    } catch (err) {
      const urls = s.page.frames().map((f) => f.url());
      throw new Error(`${String(err)} — frames: ${JSON.stringify(urls)}`);
    }
    ok('preview colorScheme matches the workspace theme', true);

    // Live flip: cms:config re-broadcast reaches the page without a reload
    await dataAction(s.page, 'theme-toggle').first().click();
    await expect.poll(frameScheme, { timeout: 30_000 }).toBe(await effective());
    ok('preview theme flips live with the workspace toggle', true);
    // Restore for the rest of the suite
    await dataAction(s.page, 'theme-toggle').first().click();
    await expect.poll(frameScheme, { timeout: 30_000 }).toBe(await effective());
  });

  it('element-picker hint banner is closeable and stays dismissed', async () => {
    // The picker banner only appears in the ACTIVE tab's iframe — hidden
    // tabs' frames also match a URL filter, so resolve via the DOM.
    const frame = async () => {
      const el = await s.page.$('#preview-frame-region iframe.is-active');
      return (await el?.contentFrame()) ?? null;
    };
    const bannerCount = async () =>
      (await (await frame())?.locator('.cms-ov-pick-help').count()) ?? 0;
    let arms = 0;
    const pick = async () => {
      arms++;
      await dataAction(s.page, 'ws-element-pick').first().click();
    };

    try {
      await pick(); // arm
      await expect.poll(bannerCount, { timeout: 15_000 }).toBeGreaterThan(0);
      await (await frame())!.locator('.cms-ov-pick-help__close').click();
      await expect.poll(bannerCount, { timeout: 10_000 }).toBe(0);
      ok('hint banner closes via its ×', true);

      await pick(); // un-arm
      await pick(); // re-arm — dismissal is remembered for this page load
      await s.page.waitForTimeout(800);
      ok('dismissed hint stays hidden on re-arm', (await bannerCount()) === 0);
    } finally {
      // A failure mid-test must not leave the picker (and its banner) armed
      // for the following tests.
      if (arms % 2 === 1) await pick();
    }
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
          'routes/URLs, and code. German anglicisms ("Browser", "Tab", "Element-Picker") count as German. ' +
          'The large area on the left is a preview IFRAME showing the user\'s own WEBSITE — ' +
          'everything inside it (e.g. nav links like "About us") is site content, not app chrome, ' +
          'and is NEVER grounds to fail. ' +
          'These exact strings are NEVER grounds to fail, wherever they appear: "CMS Agent" ' +
          '(the product name), "New chat", "Deployments", "main".',
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

  it('rail windows: git, capabilities, archive, sessions swap the stage (chat stays)', async () => {
    const openRail = async (action: string) => {
      await s.page.locator(`.ws-rail [data-action="${action}"]`).click();
      await s.page.locator('#main-region .ws-archive__panel').first().waitFor({ timeout: 15_000 });
    };
    const chatVisible = async () =>
      (await dataAction(s.page, 'machine-config-input').count()) > 0;

    await openRail('ws-git-open');
    await s.page.getByText('Initial site (basic-site)').first().waitFor({ timeout: 15_000 });
    ok('commits window lists the initial commit', true);
    ok('chat sidebar stays while a window is open', await chatVisible());
    await dataAction(s.page, 'ws-git-close').first().click();

    await openRail('ws-caps-open');
    ok('capabilities window opens', true);
    await dataAction(s.page, 'ws-caps-close').first().click();

    await openRail('ws-archive-open');
    ok('archive window opens', true);
    await dataAction(s.page, 'ws-archive-close').first().click();

    await openRail('ws-wsn-open');
    await dataAction(s.page, 'ws-wsn-fresh').first().waitFor({ timeout: 15_000 });
    ok('sessions window opens', true);
    await dataAction(s.page, 'ws-wsn-close').first().click();
    // Closing the last window returns the stage to the preview
    await s.page.locator('#preview-frame-region').waitFor({ timeout: 15_000 });
    ok('closing the window returns to the preview stage', true);
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
