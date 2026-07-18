/**
 * Scroll-sync for the side-by-side diff iframes. They are cross-origin
 * (<branch>.<BASE_DOMAIN>), so the parent can't touch their scroll directly —
 * we go through the injected bootstrap's cms:eval channel (same trust model
 * the preview agent already uses): on each iframe's cms:agent-ready we eval a
 * tiny reporter/receiver into it, then relay cms:scroll from one iframe to the
 * other as cms:scroll-to. Sync is by scroll fraction so differing content
 * heights (before vs after) still line up.
 */

const IFRAME_IDS = ['ws-diff-before', 'ws-diff-after'] as const;

// Runs inside each preview iframe (has `agent` in scope, per bootstrap eval).
// Echo suppression is by position, not timing: the scroll event caused by a
// programmatic scrollTop can arrive after the next rAF, so a timed "applying"
// flag leaks echoes back to the other pane and the two fight (jitter). Instead
// we remember the target we set and swallow the one event that lands on it.
const SYNC_CODE = `
if (!window.__cmsScrollSync) {
  window.__cmsScrollSync = true;
  var el = document.scrollingElement || document.documentElement;
  var expected = -1;
  window.addEventListener('scroll', function () {
    if (expected >= 0) {
      var wasEcho = Math.abs(el.scrollTop - expected) < 2;
      expected = -1;
      if (wasEcho) return;
    }
    var max = el.scrollHeight - el.clientHeight;
    agent.post({ type: 'cms:scroll', frac: max > 0 ? el.scrollTop / max : 0 });
  }, { passive: true });
  agent.on('cms:scroll-to', function (d) {
    var max = el.scrollHeight - el.clientHeight;
    var top = (d && typeof d.frac === 'number' ? d.frac : 0) * max;
    if (Math.abs(el.scrollTop - top) < 1) return;
    expected = top;
    el.scrollTop = top;
  });
}
`;

const iframeById = (id: string) => document.getElementById(id) as HTMLIFrameElement | null;
const originOf = (f: HTMLIFrameElement): string | null => {
  try {
    return new URL(f.src).origin;
  } catch {
    return null;
  }
};
const postTo = (f: HTMLIFrameElement, msg: Record<string, unknown>): void => {
  const origin = originOf(f);
  if (f.contentWindow && origin) f.contentWindow.postMessage(msg, origin);
};

let seq = 0;
let registered = false;

/** Leader latch: whichever pane scrolled most recently drives; cms:scroll from
 *  the other pane is dropped while the latch is fresh, so a late echo can't
 *  steer the pane the user is actually scrolling. */
let leaderId: string | null = null;
let leaderUntil = 0;
const LEADER_MS = 150;

/** Register once at app init; acts only while the diff iframes exist. */
export const registerDiffScrollSync = (): void => {
  if (registered) return;
  registered = true;

  window.addEventListener('message', (ev: MessageEvent) => {
    const frames = IFRAME_IDS.map(iframeById);
    const src = frames.find((f) => f && f.contentWindow === ev.source);
    if (!src) return; // not one of the diff iframes
    if (ev.origin !== originOf(src)) return; // origin pin

    const data = ev.data as { type?: string; frac?: number } | null;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'cms:agent-ready') {
      postTo(src, { type: 'cms:eval', id: `scroll-sync-${++seq}`, code: SYNC_CODE });
    } else if (data.type === 'cms:scroll' && typeof data.frac === 'number') {
      const now = performance.now();
      if (leaderId && leaderId !== src.id && now < leaderUntil) return;
      leaderId = src.id;
      leaderUntil = now + LEADER_MS;
      const other = frames.find((f) => f && f !== src);
      if (other) postTo(other, { type: 'cms:scroll-to', frac: data.frac });
    }
  });
};
