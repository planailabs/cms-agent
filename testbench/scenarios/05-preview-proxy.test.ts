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
        .poll(() => s.page.locator('.ws-diff-tab.is-active[data-route^="/about"]').count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);
      ok('browsed off-list route shows as the active tab', true);

      // Address input free-browses both panes back to a changed page
      const addr = s.page.locator('[data-action="ws-diff-address-form"] .ws-address__input');
      await addr.fill('/');
      await addr.press('Enter');
      await expect.poll(() => pathnameOf('ws-diff-after'), { timeout: 60_000 }).toBe('/');
      await expect.poll(() => pathnameOf('ws-diff-before'), { timeout: 60_000 }).toBe('/');
      ok('diff address input navigates both panes', true);
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
