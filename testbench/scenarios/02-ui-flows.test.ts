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

  it('new chat via the branch panel opens a draft on the branch', async () => {
    await openBranchPanel(s.page);
    await dataAction(s.page, 'ws-new-chat').first().click();
    // A draft is client-only: the composer is live, the URL carries no chat.
    await dataAction(s.page, 'machine-config-input').first().waitFor({ timeout: 30_000 });
    ok('draft chat has a live composer', true);
    ok(
      'draft chat is not addressable as a chat yet',
      !/\/chat\//.test(new URL(s.page.url()).pathname),
      s.page.url(),
    );
    // Collapse the panel again — expanded it overlays the header dropdowns.
    await dataAction(s.page, 'ws-branch-list-toggle').first().click();
    await s.page.waitForTimeout(300);
  });

  it('one-click new chat creates nothing server-side until a message', async () => {
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
    // The old behavior created a Chat row (and a worktree) per click.
    await s.page.waitForTimeout(1500);
    ok('clicking + leaves no empty chat behind', (await chatCount()) === before);
  });

  it('opening a chat from the sidebar leaves the draft behind', async () => {
    // Everything below needs a real chat (worktree-backed windows, picker).
    // With drafts, boot no longer creates one — open or make one here.
    const base = benchRun().baseUrl;
    const list = async () =>
      ((await (await s.context.request.get(`${base}/api/branches`)).json()) as {
        branches: { id: string; chats: { id: string; kind?: string; workBranch: string }[] }[];
      }).branches;
    // Must be a WORKFLOW chat: the sidebar also lists the deployments system
    // chat, which has no worktree (and so no code browser or preview).
    const workflowChat = (bs: Awaited<ReturnType<typeof list>>) =>
      bs.flatMap((b) => b.chats).find((c) => (c.kind ?? 'workflow') === 'workflow');
    let branches = await list();
    if (!workflowChat(branches)) {
      await s.context.request.post(`${base}/api/chats`, {
        data: { branchId: branches[0].id },
      });
      branches = await list();
    }
    const chatId = workflowChat(branches)!.id;
    await bootWorkspace(s.page); // reload so the sidebar sees the new chat
    await openBranchPanel(s.page);
    // Opening a chat collapses the panel itself — toggling here would
    // re-open it and its overlay would eat every later click.
    await s.page.locator(`[data-action="ws-open-chat"][data-chat-id="${chatId}"]`).first().click();
    await expect
      .poll(() => new URL(s.page.url()).pathname, { timeout: 15_000 })
      .toBe(`/chat/${chatId}`);
    ok('an existing chat opens from the sidebar', true);
    ok('opening a chat collapses the branch panel', (await s.page.locator('.ws-branch-panel').count()) === 0);

    // Everything below reads the chat's worktree (code browser) and its live
    // preview (device UA, tabs). Wait for both instead of racing a cold
    // checkout + npm install: the boot page has neither the site's markup nor
    // the injected agent, so those tests would read a spinner.
    const workBranch = workflowChat(branches)!.workBranch;
    let last = '';
    const ready = async (): Promise<boolean> => {
      const files = await s.context.request.get(`${base}/api/files/${chatId}?path=.`);
      const previews = await s.context.request.get(`${base}/api/admin/previews`);
      const { instances } = (await previews.json()) as {
        instances: Array<{ branch: string; status: string }>;
      };
      const preview = instances.find((i) => i.branch === workBranch);
      last = `files=${files.status()} preview=${preview?.status ?? 'none'}`;
      return files.status() === 200 && preview?.status === 'ready';
    };
    const deadline = Date.now() + 300_000;
    let chatReady = await ready();
    while (!chatReady && Date.now() < deadline) {
      await s.page.waitForTimeout(3_000);
      chatReady = await ready();
    }
    ok('worktree and preview are ready for the flows below', chatReady, `${workBranch} ${last}`);
  });

  it('redesign chrome: icon rail tools and compact header', async () => {
    // Icon rail: 2 stage tools + 7 registered windows (compare included) + settings
    const railButtons = await s.page.locator('.ws-rail .ws-rail__btn').count();
    ok('icon rail renders all ten tools', railButtons === 10, `${railButtons} buttons`);
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
    ok(
      'avatar shows the user icon',
      (await s.page.locator('.avatar-button .avatar-fallback svg').count()) > 0,
    );

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
    const skillTitles = await s.page.locator('.ws-caps__row .ws-git__message').allTextContents();
    ok(
      'Ponytail plugin origin sits beside the skill title',
      skillTitles.includes('ponytail via ponytail plugin'),
    );
    ok(
      'plugin origin combines with other plugin names beside the title',
      skillTitles.includes('codebase-memory via codebase-memory plugin'),
    );
    const originMatchesDescription = await s.page.evaluate(() => {
      const badges = [...document.querySelectorAll<HTMLElement>('.ws-caps__badge')];
      const badge = badges.find((element) => element.textContent?.trim() === 'via ponytail plugin');
      const description = badge?.closest('.ws-caps__row')?.querySelector<HTMLElement>('.ws-git__meta');
      return Boolean(badge && description && getComputedStyle(badge).color === getComputedStyle(description).color);
    });
    ok('plugin origin uses the description text color', originMatchesDescription);
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

    // Clicking an opener again toggles its window closed
    await openRail('ws-git-open');
    await s.page.locator(`.ws-rail [data-action="ws-git-open"]`).click();
    await s.page.locator('#preview-frame-region').waitFor({ timeout: 15_000 });
    ok('re-clicking the rail opener closes the window again', true);
  });

  it('URLs mirror chat and window state; deep links and back work', async () => {
    await s.page.waitForFunction(() => /^\/chat\/[A-Za-z0-9_-]+$/.test(location.pathname), undefined, {
      timeout: 15_000,
    });
    const chatPath = await s.page.evaluate(() => location.pathname);
    ok('URL carries the active chat id', true);

    await s.page.locator('.ws-rail [data-action="ws-git-open"]').click();
    await s.page.waitForFunction(() => location.search === '?window=git', undefined, {
      timeout: 15_000,
    });
    ok('open window is mirrored into the URL', true);

    await s.page.goBack();
    await s.page.locator('#preview-frame-region').waitFor({ timeout: 15_000 });
    await s.page.waitForFunction(() => location.search === '', undefined, { timeout: 15_000 });
    ok('browser back closes the window through the state machine', true);

    // Deep link: a fresh load boots straight into the chat + window
    await s.page.goto(`${benchRun().baseUrl}${chatPath}?window=git`, {
      waitUntil: 'domcontentloaded',
    });
    await s.page.getByText('Initial site (basic-site)').first().waitFor({ timeout: 30_000 });
    ok('deep link boots into the chat with the git window open', true);

    // Leave the stage on the preview for the following tests
    await s.page.locator('.ws-rail [data-action="ws-git-open"]').click();
    await s.page.locator('#preview-frame-region').waitFor({ timeout: 15_000 });
  });

  it('device preset resizes the preview and overrides the user agent', async () => {
    // Earlier tests can leave extra (inactive, hidden) preview tabs — every
    // iframe assertion targets the active tab's frame, which is unique.
    const select = s.page.locator('[data-action="ws-preview-device"]');
    try {
      await select.selectOption('iPhone 15');
      const frame = s.page.locator(
        '#preview-frame-region iframe.is-active[data-device="iPhone 15"]',
      );
      await frame.waitFor({ timeout: 15_000 });
      const width = await frame.evaluate((el) => (el as HTMLIFrameElement).style.width);
      ok('iframe is fixed to the device viewport', width === '393px', `width=${width}`);

      // The recreated frame carried __cms_ua → the proxy set the per-branch
      // UA override and tagged the injected script, whose bootstrap mirrors
      // it onto navigator.userAgent inside the preview document. Responsive
      // frames carry the empty clear-sentinel, so match the encoded UA value.
      let ua = '';
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const f = s.page.frames().find((fr) => fr.url().includes('__cms_ua=Mozilla'));
        if (f) {
          ua = await f.evaluate(() => navigator.userAgent).catch(() => '');
          if (ua.includes('iPhone')) break;
        }
        await s.page.waitForTimeout(500);
      }
      ok('navigator.userAgent inside the preview is the device UA', ua.includes('iPhone'), ua.slice(0, 80));
    } finally {
      // Back to responsive — a leftover device frame would skew later tests
      await select.selectOption('');
      await s.page
        .locator('#preview-frame-region iframe.is-active[data-device=""]')
        .waitFor({ timeout: 15_000 });
    }
    const cleared = await s.page
      .locator('#preview-frame-region iframe.is-active')
      .evaluate((el) => (el as HTMLIFrameElement).style.width || '(fill)');
    ok('responsive restores the fluid frame', cleared === '(fill)', cleared);
  });

  it('eye button opens compare and its tool flyout', async () => {
    const eye = dataAction(s.page, 'ws-compare-open').first();
    await eye.waitFor({ timeout: 15_000 });
    const menu = s.page.locator('.ws-compare-menu');
    ok('compare tools are listed for hover', (await menu.count()) === 1);
    ok('flyout stays hidden until asked for', !(await menu.first().isVisible()));

    await eye.click();
    await menu.first().waitFor({ state: 'visible', timeout: 10_000 });
    const tools = await s.page.locator('.ws-compare-menu__item').count();
    ok('flyout lists every compare view', tools === 4, `${tools} items`);
    ok('eye marks compare as the active window', (await s.page.locator('.ws-rail__btn.is-active[data-action="ws-compare-open"]').count()) === 1);

    // Clicking a tool switches the view and keeps the list open.
    await s.page.locator('.ws-compare-menu__item[data-mode="onion"]').click();
    ok('picked tool is marked active', (await s.page.locator('.ws-compare-menu__item.is-active[data-mode="onion"]').count()) === 1);
    ok('list stays open after picking', await menu.first().isVisible());

    // A click outside closes the list but leaves compare open.
    await s.page.locator('#sidebar-region').click({ position: { x: 5, y: 5 } });
    await expect.poll(() => menu.first().isVisible(), { timeout: 10_000 }).toBe(false);
    ok('outside click closes the list', !(await menu.first().isVisible()));
    ok(
      'compare stays open after the outside click',
      (await s.page.locator('.ws-rail__btn.is-active[data-action="ws-compare-open"]').count()) === 1,
    );

    // Clicking the active eye turns compare off again.
    await eye.click();
    await expect
      .poll(() => s.page.locator('.ws-rail__btn.is-active[data-action="ws-compare-open"]').count(), { timeout: 10_000 })
      .toBe(0);
    ok('second click leaves compare mode', true);
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

    // Image preview: expand public/ and open the seeded favicon.svg
    await s.page.locator('[data-action="ws-cb-dir"][data-path="public"]').click();
    await s.page.locator('[data-action="ws-cb-file"][data-path="public/favicon.svg"]').click();
    await s.page.locator('.ws-cb-image img').waitFor({ timeout: 15_000 });
    await expect
      .poll(() =>
        s.page.evaluate(() => {
          const el = document.querySelector<HTMLImageElement>('.ws-cb-image img');
          return Boolean(el && el.complete && el.naturalWidth > 0);
        }),
      )
      .toBe(true);
    ok('image file renders an inline preview', true);
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
