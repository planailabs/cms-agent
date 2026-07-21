/**
 * Box-diff highlight overlay: instead of a pixel-diff PNG, draw rectangles over
 * the AFTER shot for content boxes that were added / changed / removed. Driven
 * by the same markers + scored alignment the onion uses (compare/layout
 * boxDiff), so anti-aliasing and cross-browser rendering noise never light up.
 *
 * Imperative enhancer (same pattern as onionAlign): runs after every render,
 * keyed by a signature so unchanged overlays are untouched. A `[data-boxhl]`
 * element carries data-before / data-after marker-source URLs and wraps the
 * after <img>; rectangles are appended as absolutely-positioned children.
 */
import { boxDiff } from '@/lib/compare/layout';
import type { AppState } from '../chat/app/state';
import { fetchMarkers, imageSize } from './onionAlign';

const clear = (el: HTMLElement): void => {
  for (const r of el.querySelectorAll('.ws-hl-rect')) r.remove();
  delete el.dataset.hlSig;
};

async function enhance(el: HTMLElement): Promise<void> {
  const beforeSrc = el.dataset.before;
  const afterSrc = el.dataset.after;
  const img = el.querySelector<HTMLImageElement>('img');
  if (!beforeSrc || !afterSrc || !img?.src) return;

  const width = img.clientWidth;
  if (width <= 0) return;
  const sig = `${beforeSrc}|${afterSrc}|${width}`;
  if (el.dataset.hlSig === sig) return;

  const [a, b, size] = await Promise.all([
    fetchMarkers(beforeSrc),
    fetchMarkers(afterSrc),
    imageSize(afterSrc),
  ]);
  if (!el.isConnected || img.clientWidth !== width) return;
  if (!a || !b || !size || size.w <= 0) {
    clear(el);
    return;
  }

  const boxes = boxDiff(a.m, a.h, b.m, b.h);
  const scale = width / size.w;
  for (const r of el.querySelectorAll('.ws-hl-rect')) r.remove();
  for (const bx of boxes) {
    const d = document.createElement('div');
    d.className = `ws-hl-rect ws-hl-rect--${bx.kind}`;
    d.style.left = `${bx.x * scale}px`;
    d.style.top = `${bx.y * scale}px`;
    d.style.width = `${bx.w * scale}px`;
    d.style.height = `${bx.h * scale}px`;
    el.appendChild(d);
  }
  el.dataset.hlSig = sig;
}

/** Run after every render pass — draws (or clears) all box-highlight overlays. */
export const syncBoxHighlights = (_state: AppState): void => {
  for (const el of document.querySelectorAll<HTMLElement>('[data-boxhl]')) void enhance(el);
};
