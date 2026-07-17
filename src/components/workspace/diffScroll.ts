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
const SYNC_CODE = `
if (!window.__cmsScrollSync) {
  window.__cmsScrollSync = true;
  var el = document.scrollingElement || document.documentElement;
  var applying = false;
  window.addEventListener('scroll', function () {
    if (applying) return;
    var max = el.scrollHeight - el.clientHeight;
    agent.post({ type: 'cms:scroll', frac: max > 0 ? el.scrollTop / max : 0 });
  }, { passive: true });
  agent.on('cms:scroll-to', function (d) {
    var max = el.scrollHeight - el.clientHeight;
    applying = true;
    el.scrollTop = (d && typeof d.frac === 'number' ? d.frac : 0) * max;
    requestAnimationFrame(function () { applying = false; });
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
      const other = frames.find((f) => f && f !== src);
      if (other) postTo(other, { type: 'cms:scroll-to', frac: data.frac });
    }
  });
};
