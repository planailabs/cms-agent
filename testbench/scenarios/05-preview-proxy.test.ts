/**
 * Preview subdomain routing, boot pages, wait stream, injected bootstrap,
 * cross-browser shots — the proxy-facing production surface. Runs last;
 * finishes with the destructive archived-chat delete.
 */
import { describe, expect, it } from 'vitest';
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
