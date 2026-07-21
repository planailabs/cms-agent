/**
 * Content-aligned onion rendering ("content" compare mode): both screenshots
 * are sliced at matched content anchors and each row is padded to the taller
 * side, so identical content sits at identical y — exact comparison, with
 * visible blank space where one side added content.
 *
 * Imperative enhancer over the string-rendered onion markup (same pattern as
 * syncPreviewFrames): runs after every render pass, keyed by a signature so
 * unchanged containers are untouched. Markers come from `<shot>&markers=1`
 * (captured by the screenshot engine next to each PNG); a 404 or fetch error
 * falls back to plain height mode for that container.
 */
import {
  alignedSegments,
  computeAnchors,
  type AlignedSegment,
  type MarkerDoc,
} from '@/lib/compare/markers';
import type { AppState } from '../chat/app/state';

const markerCache = new Map<string, Promise<MarkerDoc | null>>();
const sizeCache = new Map<string, Promise<{ w: number; h: number } | null>>();

const fetchMarkers = (shotSrc: string): Promise<MarkerDoc | null> => {
  const url = `${shotSrc}&markers=1`;
  let p = markerCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<MarkerDoc>) : null))
      .catch(() => null);
    markerCache.set(url, p);
    p.then((v) => {
      if (!v) markerCache.delete(url); // allow retry (shot may not exist yet)
    });
  }
  return p;
};

const imageSize = (src: string): Promise<{ w: number; h: number } | null> => {
  let p = sizeCache.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = src;
    });
    sizeCache.set(src, p);
    p.then((v) => {
      if (!v) sizeCache.delete(src);
    });
  }
  return p;
};

// A shot is served from our own API (same-origin), so its pixels are readable.
// Cache one canvas per image for background-colour sampling.
const ctxCache = new Map<string, CanvasRenderingContext2D | null>();
const ctxFor = (img: HTMLImageElement): CanvasRenderingContext2D | null => {
  if (!img.complete || img.naturalWidth === 0) return null; // not decoded yet; retry later
  const key = img.src;
  const hit = ctxCache.get(key);
  if (hit !== undefined) return hit;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const c = cv.getContext('2d', { willReadFrequently: true });
    if (c) {
      c.drawImage(img, 0, 0);
      ctx = c;
    }
  } catch {
    ctx = null; // tainted / unsupported → callers fall back to no fill
  }
  ctxCache.set(key, ctx);
  return ctx;
};

/** Dominant colour of the pixel row at natural y — the page background, since
 *  text/foreground is a minority of a row's width. Returns '' if unreadable. */
const rowColor = (ctx: CanvasRenderingContext2D, yNatural: number): string => {
  const { width, height } = ctx.canvas;
  const y = Math.max(0, Math.min(height - 1, Math.round(yNatural)));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, y, width, 1).data;
  } catch {
    return '';
  }
  const counts = new Map<string, number>();
  let best = '';
  let bestN = 0;
  for (let x = 0; x < width; x += 6) {
    const i = x * 4;
    const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`; // quantized
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > bestN) {
      bestN = n;
      best = key;
    }
  }
  if (!best) return '';
  const [r, g, b] = best.split(',').map((v) => (parseInt(v, 10) << 3) + 4);
  return `rgb(${r}, ${g}, ${b})`;
};

const buildColumn = (
  img: HTMLImageElement,
  segs: AlignedSegment[],
  side: 'a' | 'b',
  scale: number,
  naturalH: number,
): HTMLElement => {
  const src = img.src;
  const ctx = ctxFor(img);
  const col = document.createElement('div');
  col.className = 'ws-onion__segments';
  for (const seg of segs) {
    const top = side === 'a' ? seg.topA : seg.topB;
    const own = side === 'a' ? seg.hA : seg.hB;

    if (own > 0) {
      // The slice itself, at natural scale — content is never distorted.
      const div = document.createElement('div');
      div.className = 'ws-onion__segment';
      div.style.height = `${own * scale}px`;
      div.style.backgroundImage = `url("${src}")`;
      div.style.backgroundSize = `100% ${naturalH * scale}px`;
      div.style.backgroundPosition = `0px ${-top * scale}px`;
      col.appendChild(div);
    }

    const fill = seg.h - own;
    if (fill > 0) {
      // Filler is a SOLID background colour sampled from the page (the
      // dominant colour at the slice's bottom edge / just above the anchor),
      // NOT a stretched image strip — stretching smears any text in the strip
      // into vertical streaks.
      const filler = document.createElement('div');
      filler.className = 'ws-onion__segment ws-onion__filler';
      filler.style.height = `${fill * scale}px`;
      const sampleY = own > 0 ? top + own - 1 : Math.max(0, top - 1);
      const color = ctx ? rowColor(ctx, sampleY) : '';
      if (color) filler.style.backgroundColor = color;
      col.appendChild(filler);
    }
  }
  return col;
};

const cleanup = (container: HTMLElement): void => {
  container.classList.remove('is-content-aligned');
  for (const el of container.querySelectorAll('.ws-onion__segments')) el.remove();
  delete container.dataset.alignSig;
};

interface Observed extends HTMLElement {
  __alignObserver?: ResizeObserver;
}

async function enhance(container: HTMLElement, mode: 'height' | 'content'): Promise<void> {
  const beforeWrap = container.querySelector<HTMLElement>('.ws-onion__before');
  const afterWrap = container.querySelector<HTMLElement>('.ws-onion__after');
  const beforeImg = beforeWrap?.querySelector<HTMLImageElement>('img');
  const afterImg = afterWrap?.querySelector<HTMLImageElement>('img');
  if (!beforeWrap || !afterWrap || !beforeImg?.src || !afterImg?.src) return;

  if (mode === 'height') {
    // Drop the observer FIRST — the cleanup resize would re-enhance
    const obs = container as Observed;
    obs.__alignObserver?.disconnect();
    delete obs.__alignObserver;
    if (container.dataset.alignSig) cleanup(container);
    return;
  }

  // Scale from the COLUMN width (equals the container in the stacked onion
  // layout, half of it in the browser-compare side-by-side scroll mode).
  const width = beforeWrap.clientWidth;
  const sig = `${beforeImg.src}|${afterImg.src}|${width}`;
  if (container.dataset.alignSig === sig) return;

  const [a, b, sizeA, sizeB] = await Promise.all([
    fetchMarkers(beforeImg.src),
    fetchMarkers(afterImg.src),
    imageSize(beforeImg.src),
    imageSize(afterImg.src),
  ]);
  // Re-check: render passes may have replaced the DOM while we fetched
  if (!container.isConnected || beforeWrap.clientWidth !== width) return;
  if (!a || !b || !sizeA || !sizeB || sizeA.w <= 0) {
    cleanup(container); // no markers → height mode for this pair
    return;
  }

  const segs = alignedSegments(computeAnchors(a.m, b.m), a.h, b.h);
  if (segs.length === 0) {
    cleanup(container);
    return;
  }
  const scale = width / sizeA.w;

  for (const el of container.querySelectorAll('.ws-onion__segments')) el.remove();
  beforeWrap.appendChild(buildColumn(beforeImg, segs, 'a', scale, sizeA.h));
  afterWrap.appendChild(buildColumn(afterImg, segs, 'b', scale, sizeB.h));
  container.classList.add('is-content-aligned');
  container.dataset.alignSig = sig;

  // Re-run on width changes (sidebar resize etc.) — signature includes width
  const obs = container as Observed;
  if (!obs.__alignObserver) {
    obs.__alignObserver = new ResizeObserver(() => {
      void enhance(container, 'content');
    });
    obs.__alignObserver.observe(container);
  }
}

/** Run after every render pass — enhances (or restores) all onion views. */
export const syncOnionAlignment = (state: AppState): void => {
  const mode = state.workspace.compareMode;
  for (const el of document.querySelectorAll<HTMLElement>('[data-onion]')) {
    void enhance(el, mode);
  }
};
