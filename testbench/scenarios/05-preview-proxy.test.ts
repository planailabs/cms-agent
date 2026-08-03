/**
 * Preview subdomain routing, boot pages, wait stream, injected bootstrap,
 * cross-browser shots — the proxy-facing production surface. Runs last;
 * finishes with the destructive archived-chat delete.
 */
import { describe, expect, it } from 'vitest';
import { bootWorkspace, launchBrowser, newSession, openBranchPanel } from '../lib/browser';
import { BenchClient } from '../lib/client';
import { benchRun, previewUrl } from '../lib/env';
import { recordAssert } from '../lib/judge';
import { loadJourney } from '../lib/journey';

const SCENARIO = '05-proxy';
const client = new BenchClient();

const ok = (name: string, pass: boolean, detail = '') => {
  recordAssert(SCENARIO, name, pass, detail);
  expect(pass, `${name}: ${detail}`).toBe(true);
};

/** Fetch a preview route until the dev server actually serves it — the boot
 *  page is also 200 HTML ("Starting preview…"), so a site-specific marker is
 *  required. */
async function waitForPreview(url: string, marker: RegExp, timeoutMs = 420_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: client.headers() });
      last = await res.text();
      if (res.status === 200 && marker.test(last) && !/Starting preview/i.test(last)) return last;
    } catch {
      /* proxy hiccup while instance restarts */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`preview at ${url} never served (last: ${last.slice(0, 200)})`);
}

describe('preview + proxy', () => {
  it('main preview boots on demand and carries the injected bootstrap', async () => {
    const html = await waitForPreview(previewUrl('main'), /Acme Consulting/);
    ok('preview serves the site through the proxy', true);
    ok(
      'preview HTML carries the injected agent script',
      html.includes('injected-cms-agent'),
      html.slice(0, 300),
    );
  }, 500_000);

  it('published change is live on the main preview', async () => {
    if (!loadJourney()) {
      recordAssert(SCENARIO, 'published change live on main', true, 'n/a — e2e group not run');
      return;
    }
    const html = await waitForPreview(previewUrl('main', '/about'), /Hello Bench/);
    ok('about page shows "Hello Bench" after publish', html.includes('Hello Bench'));
  }, 500_000);

  it('boot page redirects on the CMS host; wait stream reports readiness', async () => {
    const res = await fetch(`${benchRun().baseUrl}/__preview/boot/main`, {
      headers: client.headers(),
      redirect: 'manual',
    });
    const location = res.headers.get('location') ?? '';
    ok(
      'CMS-host boot path redirects to the preview host',
      res.status >= 300 && res.status < 400 && location.includes('main.'),
      `${res.status} ${location}`,
    );

    // SSE wait stream on the CMS host (a ROUTED preview host forwards
    // /__preview/* to the site server). Instance is up → immediate `ready`.
    const controller = new AbortController();
    const stream = await fetch(`${benchRun().baseUrl}/__preview/wait/main`, {
      headers: client.headers(),
      signal: controller.signal,
    });
    let sawReady = false;
    if (stream.ok && stream.body) {
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 120_000;
      let buf = '';
      while (Date.now() < deadline && !sawReady) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        sawReady = /event: ready/.test(buf);
      }
    }
    controller.abort();
    ok('wait stream announces readiness', sawReady, `http ${stream.status}`);
  }, 300_000);

  it('unknown preview hosts fall back safely', async () => {
    const res = await fetch(previewUrl('no-such-branch'), { headers: client.headers() });
    const body = await res.text();
    ok('unknown branch is not a 5xx', res.status < 500, `got ${res.status}`);
    recordAssert(SCENARIO, 'unknown branch behavior (info)', true, `${res.status}: ${body.slice(0, 80)}`);
  });

  it('cross-browser shot renders chromium vs firefox', async () => {
    const shot = await client.getBinary(
      '/api/preview/browsers-shot?branch=main&route=/&a=chromium&b=firefox&kind=diff',
    );
    ok('browsers-shot diff PNG', shot.status === 200 && shot.type.includes('image/png'), `${shot.status} ${shot.type}`);
    const meta = await client.get(
      '/api/preview/browsers-shot?branch=main&route=/&a=chromium&b=firefox&kind=diff&meta=1',
    );
    ok('browsers-shot meta JSON', meta.status === 200);
  }, 500_000);

  it('cross-browser shot honors a device preset', async () => {
    const dev = encodeURIComponent('iPhone 15');
    const shot = await client.getBinary(
      `/api/preview/browsers-shot?branch=main&route=/&a=chromium&b=firefox&kind=after&device=${dev}`,
    );
    ok('device-emulated shot PNG', shot.status === 200 && shot.type.includes('image/png'), `${shot.status} ${shot.type}`);
    const bad = await client.get(
      '/api/preview/browsers-shot?branch=main&route=/&a=chromium&b=firefox&kind=diff&device=Nokia%203310',
    );
    ok('unknown device is a 400', bad.status === 400, `got ${bad.status}`);
  }, 500_000);

  it('diff viewer: browsing one pane syncs the other + tabs; address free-browses', async () => {
    const j = loadJourney();
    if (!j?.chatB) {
      recordAssert(SCENARIO, 'diff browse sync', true, 'n/a — e2e group not run');
      return;
    }
    const browser = await launchBrowser();
    try {
      const s = await newSession(browser);
      await bootWorkspace(s.page);
      await openBranchPanel(s.page);
      await s.page
        .locator(`[data-action="ws-open-chat"][data-chat-id="${j.chatB}"]`)
        .first()
        .click();

      // Reviewing is no longer a phase: open the compare window from the rail.
      await s.page.locator('[data-action="ws-compare-open"]').click();

      // Frames are recreated on every route change — always re-query.
      const paneFrame = async (id: string) => {
        const el = await s.page.$(`#${id}`);
        return el ? await el.contentFrame() : null;
      };
      // Trailing-slash-insensitive (sites may serve either form)
      const pathnameOf = async (id: string): Promise<string | null> => {
        const frame = await paneFrame(id);
        if (!frame) return null;
        try {
          return new URL(frame.url()).pathname.replace(/\/+$/, '') || '/';
        } catch {
          return null;
        }
      };
      // Side-by-side is the default mode; wait until the AFTER pane serves
      // the real site (boot page has no nav links; worktree deps may install).
      await s.page.locator('#ws-diff-after').waitFor({ state: 'attached', timeout: 60_000 });
      const aboutLink = async () =>
        (await (await paneFrame('ws-diff-after'))?.locator('a[href^="/about"]').count()) ?? 0;
      await expect.poll(aboutLink, { timeout: 300_000 }).toBeGreaterThan(0);
      ok('diff panes render the site side-by-side', true);

      // Browse inside the AFTER pane → the other pane + page tabs follow
      await (await paneFrame('ws-diff-after'))!.locator('a[href^="/about"]').first().click();
      await expect.poll(() => pathnameOf('ws-diff-before'), { timeout: 60_000 }).toBe('/about');
      ok('browsing one pane navigates the other to the same route', true);
      await expect
        .poll(() => s.page.locator('.ws-route-chip[data-active-route^="/about"]').count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);
      ok('browsed off-list route shows in the route chip', true);

      // Address input free-browses both panes back to a changed page
      const addr = s.page.locator('[data-nav="diff"] .ws-address__input');
      await addr.fill('/');
      await addr.press('Enter');
      await expect.poll(() => pathnameOf('ws-diff-after'), { timeout: 60_000 }).toBe('/');
      await expect.poll(() => pathnameOf('ws-diff-before'), { timeout: 60_000 }).toBe('/');
      ok('diff address input navigates both panes', true);

      // Reload button (shared navigation bar): the pane document is really
      // re-requested — a mark set in the live document does not survive it.
      await (await paneFrame('ws-diff-after'))!.evaluate(() => {
        (window as unknown as Record<string, unknown>).__benchReloadMark = 1;
      });
      await s.page.locator('[data-nav="diff"] [data-action="ws-nav-reload"]').click();
      await expect
        .poll(
          async () => {
            const frame = await paneFrame('ws-diff-after');
            if (!frame) return false;
            return frame
              .evaluate(
                () =>
                  (window as unknown as Record<string, unknown>).__benchReloadMark === undefined,
              )
              .catch(() => false);
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      ok('navigation reload re-requests the pane document', true);

      // Route-chip dropdown (redesign) lists the changed pages; picking one
      // navigates the panes and closes the dropdown.
      await s.page.locator('[data-action="ws-diff-routes-toggle"]').click();
      await s.page.locator('.ws-route-pop').waitFor({ timeout: 10_000 });
      const items = s.page.locator('.ws-route-pop__item');
      const entryCount = await items.count();
      ok('route dropdown lists the changed pages', entryCount > 0, `${entryCount} entries`);
      const targetRoute = await items.first().getAttribute('data-route');
      await items.first().click();
      await s.page.locator('.ws-route-pop').waitFor({ state: 'detached', timeout: 10_000 });
      ok('route pick closes the dropdown', true);
      if (targetRoute) {
        const want = targetRoute.replace(/\/+$/, '') || '/';
        await expect.poll(() => pathnameOf('ws-diff-after'), { timeout: 60_000 }).toBe(want);
        ok('route pick navigates the panes', true);
      }

      // Review verdicts live under the composer (redesign action row)
      const publish = s.page.locator('.chat-actions-row [data-action="ws-publish"]');
      ok('publish renders in the composer action row', (await publish.count()) > 0);
      ok(
        'request-changes renders in the composer action row',
        (await s.page.locator('.chat-actions-row [data-action="ws-request-changes"]').count()) > 0,
      );
    } finally {
      await browser.close();
    }
  }, 600_000);

  it('chat transcript keeps scroll position across rerenders', async () => {
    const j = loadJourney();
    if (!j?.chatB) {
      recordAssert(SCENARIO, 'chat scroll preserve', true, 'n/a — e2e group not run');
      return;
    }
    const browser = await launchBrowser();
    try {
      const s = await newSession(browser);
      await bootWorkspace(s.page);
      await openBranchPanel(s.page);
      await s.page
        .locator(`[data-action="ws-open-chat"][data-chat-id="${j.chatB}"]`)
        .first()
        .click();
      const region = s.page.locator('#chat-scroll-region');
      await region.waitFor({ timeout: 30_000 });
      await s.page.waitForTimeout(1000);
      const overflows = await region.evaluate((el) => el.scrollHeight > el.clientHeight + 100);
      if (!overflows) {
        recordAssert(SCENARIO, 'chat scroll preserve', true, 'n/a — transcript too short');
        return;
      }
      // Scroll up, force a full workspace rerender (theme toggle), position
      // must survive — the old renderer jumped on every SSE/tool event.
      await region.evaluate((el) => {
        el.scrollTop = 5;
      });
      await s.page.locator('[data-action="theme-toggle"]').first().click();
      await s.page.waitForTimeout(500);
      const topAfter = await region.evaluate((el) => el.scrollTop);
      ok('scrolled-up position survives a rerender', topAfter < 100, `scrollTop ${topAfter}`);
      // Pinned to the bottom → rerender keeps following the tail.
      await region.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await s.page.locator('[data-action="theme-toggle"]').first().click();
      await s.page.waitForTimeout(500);
      const pinned = await region.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60,
      );
      ok('pinned-to-bottom follows after a rerender', pinned);
    } finally {
      await browser.close();
    }
  }, 300_000);

  it('element picker works from the compare window', async () => {
    const j = loadJourney();
    if (!j?.chatB) {
      recordAssert(SCENARIO, 'diff picker', true, 'n/a — e2e group not run');
      return;
    }
    const browser = await launchBrowser();
    try {
      const s = await newSession(browser);
      await bootWorkspace(s.page);
      await openBranchPanel(s.page);
      await s.page
        .locator(`[data-action="ws-open-chat"][data-chat-id="${j.chatB}"]`)
        .first()
        .click();
      // Diff controls render once the compare window is open and the changed
      // pages load; the picker entry point lives in the icon rail (redesign).
      await s.page.locator('[data-action="ws-compare-open"]').click();
      await s.page.locator('.ws-route-chip').waitFor({ timeout: 60_000 });
      const pick = s.page.locator('.ws-rail [data-action="ws-element-pick"]');
      await pick.waitFor({ timeout: 10_000 });
      const diffRoute = await s.page
        .locator('.ws-route-chip')
        .first()
        .getAttribute('data-active-route');
      ok('picker button renders in the icon rail', true);

      // Arming the picker swaps to the live preview on the reviewed page
      await pick.click();
      await s.page.locator('#preview-frame-region iframe').first().waitFor({ timeout: 30_000 });
      const addr = await s.page.locator('.ws-address__input').first().inputValue();
      const key = (r: string) => r.replace(/\/+$/, '') || '/';
      ok(
        'live preview opens on the reviewed diff route',
        diffRoute !== null && key(addr) === key(diffRoute),
        `addr=${addr} diff=${diffRoute}`,
      );
      const armed = s.page.locator('[data-action="ws-element-pick"].is-active');
      ok('picker shows armed', (await armed.count()) > 0);

      // Cancelling returns to the diff viewer
      await armed.first().click();
      await s.page.locator('.ws-diff').first().waitFor({ timeout: 30_000 });
      ok('cancelling the pick returns to the diff viewer', true);
    } finally {
      await browser.close();
    }
  }, 300_000);

  it('edit mode offers the swap tool (with cursor/move/draw/comment)', async () => {
    const j = loadJourney();
    if (!j?.chatB) {
      recordAssert(SCENARIO, 'swap tool present', true, 'n/a — e2e group not run');
      return;
    }
    const browser = await launchBrowser();
    try {
      const s = await newSession(browser);
      await bootWorkspace(s.page);
      await openBranchPanel(s.page);
      await s.page
        .locator(`[data-action="ws-open-chat"][data-chat-id="${j.chatB}"]`)
        .first()
        .click();
      // Journey B rests on its finish_execution card, whose decision row takes
      // the composer's place until it is answered or dismissed — and the end of
      // this test asks the agent about the pending edits, which needs it back.
      // Dismissing is client-side only (workspace/actions.dismissFinishExecution
      // just marks the prompt dismissed in the store), so the earlier test that
      // asserts the publish row still sees it in its own session.
      // Journey B rests on its finish_execution card, whose decision row takes
      // the composer's place — and the end of this test asks the agent about
      // the pending edits, which needs the composer back.
      //
      // Waiting for the CARD, not for "composer or card": the composer is
      // what's on screen until the chat's state arrives, so the either-or
      // resolves immediately on it, the dismiss is skipped, and the card
      // lands a moment later — leaving the fill at the end of this test to
      // time out against a slot the card had taken.
      const chatComposer = s.page.locator('[data-action="machine-config-input"]').first();
      const dismissFinish = s.page.locator('[data-action="ws-dismiss-finish"]').first();
      await dismissFinish.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
        // No card for this chat — the composer is already the live one.
      });
      if (await dismissFinish.isVisible()) {
        await dismissFinish.click();
        await chatComposer.waitFor({ state: 'visible', timeout: 10_000 });
      }
      // Reviewing is no longer a phase: the diff viewer IS the compare window,
      // and opening a chat no longer opens it — edit mode starts from there.
      await s.page.locator('[data-action="ws-compare-open"]').click();
      await s.page.locator('.ws-diff').first().waitFor({ timeout: 60_000 });
      const editBtn = s.page.locator('.ws-rail [data-action="ws-edit-mode"]:not([disabled])');
      await editBtn.waitFor({ timeout: 60_000 });
      await editBtn.click();
      // Clicking parks the pointer on the rail slot, and hovering that slot is
      // precisely what opens the flyout — so without moving away first, this
      // check hovers the thing it is asserting is not hovered. Whether it saw
      // "hidden" came down to which side of the CSS transition it sampled.
      await s.page.mouse.move(0, 0);
      const editMenu = s.page.locator('.ws-edit-menu');
      await expect.poll(() => editMenu.isVisible(), { timeout: 5_000 }).toBe(false);
      ok('edit tools stay hidden until the edit icon is hovered', !(await editMenu.isVisible()));
      // The rail BUTTON opens the flyout; the flyout carries an exit item of
      // its own (see rail.ts), so an unscoped .ws-rail lookup matches both.
      await s.page.locator('.ws-rail__btn[data-action="ws-edit-exit"]').hover();
      await editMenu.waitFor({ state: 'visible', timeout: 10_000 });
      const tools = await editMenu.locator('[data-action="ws-edit-tool"]').count();
      ok('edit icon flyout lists all five tools', tools === 5, `${tools} tools`);
      ok('undo controls stay hidden before the first edit', (await s.page.locator('#preview-toolbar-region [data-action^="ws-edit-"]').filter({ hasText: 'Undo' }).count()) === 0);
      ok('edit mode has no separate handoff button', (await s.page.locator('[data-action="ws-edit-handoff"]').count()) === 0);
      await s.page.locator('[data-action="ws-edit-tool"][data-tool="comment"]').click();
      const activeTool = s.page.locator('[data-edit-active-tool="comment"]');
      // Every check below samples state the toolbar/overlay reaches a frame
      // after the action — poll first, then record, so a real failure still
      // lands in the report instead of killing the test before its ok().
      await expect.poll(() => activeTool.count(), { timeout: 5_000 }).toBe(1).catch(() => {});
      ok('toolbar shows the active comment mode', (await activeTool.count()) === 1);
      ok('active mode uses the highlighted button style', await activeTool.evaluate((el) => getComputedStyle(el).color !== getComputedStyle(el.parentElement!).color));
      const preview = await s.page.locator('#preview-frame-region iframe').first().elementHandle();
      const frame = await preview?.contentFrame();
      const target = frame?.locator('main, body > *').first();
      await target?.hover();
      const commentHighlight = frame?.locator('.cms-ov-hl');
      await expect
        .poll(() => commentHighlight?.isVisible() ?? false, { timeout: 5_000 })
        .toBe(true)
        .catch(() => {});
      const highlighted =
        (await commentHighlight?.isVisible()) === true &&
        (await commentHighlight.evaluate((el) => getComputedStyle(el).backgroundColor)) !==
          'rgba(0, 0, 0, 0)';
      ok('comment tool highlights its target in blue', highlighted);
      await target?.click();
      const commentInput = frame?.locator('.cms-ov-edit-input input');
      await commentInput?.fill('Bench comment');
      const submitComment = frame?.getByRole('button', { name: 'Submit' });
      ok('comment input exposes an icon submit button', (await submitComment?.locator('svg').isVisible()) === true);
      await submitComment?.click();
      await s.page.locator('#preview-toolbar-region [data-action="ws-edit-undo"]').waitFor({ state: 'visible' });
      // By action, not by label: "Undo all" contains "Undo", so a role+name
      // lookup counts both buttons and the two checks below stop meaning what
      // they say.
      const undoCount = await s.page.locator('#preview-toolbar-region [data-action="ws-edit-undo"]').count();
      const undoAllCount = await s.page.locator('#preview-toolbar-region [data-action="ws-edit-clear"]').count();
      ok('undo appears after the first edit', undoCount === 1, `${undoCount} undo buttons`);
      ok('undo all stays hidden after one edit', undoAllCount === 0, `${undoAllCount} undo-all buttons`);
      // Same reason as the counts above: the transcript's execution cards carry
      // their own "Undo", so every one of these controls is addressed by the
      // action it fires, inside the toolbar it belongs to.
      await s.page.locator('#preview-toolbar-region [data-action="ws-edit-undo"]').click();
      const redo = s.page.locator('#preview-toolbar-region [data-action="ws-edit-redo"]');
      await redo.waitFor({ state: 'visible' });
      ok('redo with a forward-history icon appears after undo', (await redo.locator('svg').isVisible()) === true);
      await redo.click();
      // The tool list is a hover flyout (asserted above) and the pointer has
      // been inside the preview since the comment was placed, so it closed
      // behind us — switching tools means reopening it, the same way the exit
      // item is reached at the end of this test.
      await s.page.locator('.ws-rail__btn[data-action="ws-edit-exit"]').hover();
      await editMenu.waitFor({ state: 'visible', timeout: 10_000 });
      await s.page.locator('[data-action="ws-edit-tool"][data-tool="cursor"]').click();
      // The bubbles re-render when the tool changes, so the pencil arrives a
      // frame after the click — same reason every other control here is
      // waited for rather than sampled.
      const editComment = frame?.getByRole('button', { name: 'Edit comment' });
      await editComment?.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      ok('comments expose a pencil edit button', (await editComment?.isVisible()) === true);
      await editComment?.click();
      await expect
        .poll(() => commentInput?.inputValue() ?? '', { timeout: 5_000 })
        .toBe('Bench comment')
        .catch(() => {});
      ok('comment edit pre-fills the old text', (await commentInput?.inputValue()) === 'Bench comment');
      await commentInput?.fill('Updated bench comment');
      await commentInput?.press('Enter');
      const undoAll = s.page.locator('#preview-toolbar-region [data-action="ws-edit-clear"]');
      await undoAll.waitFor({ state: 'visible' });
      ok('undo all appears after the second edit with its reset-history icon', (await undoAll.locator('svg').isVisible()) === true);
      await undoAll.click();
      await redo.waitFor({ state: 'visible' });
      ok('redo appears after undo all', true);
      await redo.click();
      // Redo restores the pre-clear snapshot in the IFRAME and the toolbar
      // follows from the state it posts back — so the toolbar regaining
      // "undo all" (two edits again) is the signal that the redo landed.
      // Counting bubbles straight after the click races that round trip.
      await undoAll.waitFor({ state: 'visible', timeout: 10_000 });
      ok(
        'comment edit saves the new text',
        (await frame?.locator('.cms-ov-bubble').filter({ hasText: 'Updated bench comment' }).count()) === 1,
      );
      let sentContext: { editAnnotations?: { comments?: Array<{ text?: string }> } } | undefined;
      await s.page.route('**/api/chat/message', async (route) => {
        sentContext = (route.request().postDataJSON() as { pageContext?: typeof sentContext }).pageContext;
        await route.fulfill({ status: 202, contentType: 'application/json', body: '{"status":"accepted"}' });
      });
      const composer = s.page.locator('[data-action="machine-config-input"]');
      await composer.fill('What do you think about these edits?');
      await composer.press('Enter');
      await s.page.waitForFunction(() => document.querySelector('[data-action="machine-config-input"]')?.textContent === '');
      ok('chat messages carry pending edit annotations as context', sentContext?.editAnnotations?.comments?.[0]?.text === 'Updated bench comment');
      await expect
        .poll(() => s.page.locator('[data-edit-active-tool]').count(), { timeout: 5_000 })
        .toBe(1)
        .catch(() => {});
      ok('asking about pending edits leaves edit mode active', (await s.page.locator('[data-edit-active-tool]').count()) === 1);
      await s.page.locator('.ws-rail__btn[data-action="ws-edit-exit"]').hover();
      await editMenu.locator('[data-action="ws-edit-exit"]').click();
      await s.page.locator('.ws-diff').first().waitFor({ timeout: 30_000 });
      ok('exiting edit mode returns to the diff viewer', true);
    } finally {
      await browser.close();
    }
  }, 300_000);

  it('archived chat can be deleted permanently (final destructive probe)', async () => {
    const journey = loadJourney();
    if (!journey) {
      recordAssert(SCENARIO, 'archived delete', true, 'n/a — e2e group not run');
      return;
    }
    const archived = (await client.get('/api/chats/archived')).json as {
      chats?: { id: string }[];
    };
    if (!(archived.chats ?? []).some((c) => c.id === journey.chatId)) {
      recordAssert(SCENARIO, 'archived delete', true, 'n/a — journey chat not archived');
      return;
    }
    const del = await client.req('DELETE', `/api/chats/archived?id=${journey.chatId}`);
    ok('archived journey chat deleted', del.status === 200, `${del.status} ${del.text.slice(0, 200)}`);
  });
});
