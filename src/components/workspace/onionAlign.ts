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
import { buildLayout, type ANode } from '@/lib/compare/layout';
import type { AppState } from '../chat/app/state';

const markerCache = new Map<string, Promise<MarkerDoc | null>>();
const sizeCache = new Map<string, Promise<{ w: number; h: number } | null>>();

export const fetchMarkers = (shotSrc: string): Promise<MarkerDoc | null> => {
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

export const imageSize = (src: string): Promise<{ w: number; h: number } | null> => {
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

/** Dominant colour of a pixel row within [x0,x1) at natural y — the local page
 *  background, since text/foreground is a minority of a row's width. '' if
 *  unreadable. */
const rowColor = (
  ctx: CanvasRenderingContext2D,
  yNatural: number,
  x0 = 0,
  x1 = ctx.canvas.width,
): string => {
  const { width, height } = ctx.canvas;
  const y = Math.max(0, Math.min(height - 1, Math.round(yNatural)));
  const lo = Math.max(0, Math.min(width - 1, Math.round(x0)));
  const w = Math.max(1, Math.min(width - lo, Math.round(x1 - x0)));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(lo, y, w, 1).data;
  } catch {
    return '';
  }
  const counts = new Map<string, number>();
  let best = '';
  let bestN = 0;
  for (let x = 0; x < w; x += 6) {
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

// ── 2-D rectangle-split rendering ─────────────────────────────────────────

interface RC {
  src: string;
  ctx: CanvasRenderingContext2D | null;
  scale: number;
  naturalW: number;
  naturalH: number;
}

/** A content slice: the source rect [x0,top]→[x0+w,top+own] at natural scale. */
const sliceEl = (rc: RC, x0: number, top: number, w: number, own: number): HTMLElement => {
  const d = document.createElement('div');
  d.className = 'ws-onion__segment';
  d.style.width = `${w * rc.scale}px`;
  d.style.height = `${own * rc.scale}px`;
  d.style.backgroundImage = `url("${rc.src}")`;
  d.style.backgroundSize = `${rc.naturalW * rc.scale}px ${rc.naturalH * rc.scale}px`;
  d.style.backgroundPosition = `${-x0 * rc.scale}px ${-top * rc.scale}px`;
  return d;
};

/** A gap filler: solid page-background colour sampled within [x0,x0+w] at y. */
const fillerEl = (rc: RC, x0: number, w: number, fill: number, sampleY: number): HTMLElement => {
  const d = document.createElement('div');
  d.className = 'ws-onion__segment ws-onion__filler';
  d.style.width = `${w * rc.scale}px`;
  d.style.height = `${fill * rc.scale}px`;
  const color = rc.ctx ? rowColor(rc.ctx, sampleY, x0, x0 + w) : '';
  if (color) d.style.backgroundColor = color;
  return d;
};

/** Natural y of a node's content bottom on one side (for filler sampling). */
const bottomY = (node: ANode, side: 'a' | 'b'): number => {
  if (node.kind === 'leaf') {
    let y = 0;
    for (const seg of node.segs ?? []) {
      const top = side === 'a' ? seg.topA : seg.topB;
      const own = side === 'a' ? seg.hA : seg.hB;
      if (own > 0) y = Math.max(y, top + own);
    }
    return y;
  }
  const kids = node.children ?? [];
  if (node.kind === 'col') return kids.length ? bottomY(kids[kids.length - 1], side) : 0;
  return kids.length ? Math.max(...kids.map((c) => bottomY(c, side))) : 0;
};

/** Render one side of an aligned node, padded to `targetH` natural px. */
const renderNode = (node: ANode, side: 'a' | 'b', rc: RC, targetH: number): HTMLElement => {
  const el = document.createElement('div');
  el.className = 'ws-onion__box';
  el.style.width = `${node.w * rc.scale}px`;
  if (node.kind === 'leaf') {
    for (const seg of node.segs ?? []) {
      const top = side === 'a' ? seg.topA : seg.topB;
      const own = side === 'a' ? seg.hA : seg.hB;
      if (own > 0) el.appendChild(sliceEl(rc, node.x0, top, node.w, own));
      const fill = seg.h - own;
      if (fill > 0) {
        el.appendChild(fillerEl(rc, node.x0, node.w, fill, own > 0 ? top + own - 1 : Math.max(0, top - 1)));
      }
    }
  } else if (node.kind === 'col') {
    for (const c of node.children ?? []) el.appendChild(renderNode(c, side, rc, c.h));
  } else {
    el.style.display = 'flex';
    for (const c of node.children ?? []) el.appendChild(renderNode(c, side, rc, node.h));
  }
  const pad = targetH - node.h;
  if (pad > 0.5) el.appendChild(fillerEl(rc, node.x0, node.w, pad, bottomY(node, side)));
  return el;
};

const cleanup = (container: HTMLElement): void => {
  container.classList.remove('is-content-aligned');
  for (const el of container.querySelectorAll('.ws-onion__segments, .ws-onion__box')) el.remove();
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

  const scale = width / sizeA.w;
  for (const el of container.querySelectorAll('.ws-onion__segments, .ws-onion__box')) el.remove();

  // Preferred: 2-D rectangle-split layout (needs bounding boxes in markers).
  const layout = buildLayout(a.m, a.h, b.m, b.h);
  if (layout) {
    const rcA: RC = { src: beforeImg.src, ctx: ctxFor(beforeImg), scale, naturalW: sizeA.w, naturalH: sizeA.h };
    const rcB: RC = { src: afterImg.src, ctx: ctxFor(afterImg), scale, naturalW: sizeB.w, naturalH: sizeB.h };
    beforeWrap.appendChild(renderNode(layout, 'a', rcA, layout.h));
    afterWrap.appendChild(renderNode(layout, 'b', rcB, layout.h));
  } else {
    // Fallback: plain 1-D column (old marker caches without boxes).
    const segs = alignedSegments(computeAnchors(a.m, b.m), a.h, b.h);
    if (segs.length === 0) {
      cleanup(container);
      return;
    }
    beforeWrap.appendChild(buildColumn(beforeImg, segs, 'a', scale, sizeA.h));
    afterWrap.appendChild(buildColumn(afterImg, segs, 'b', scale, sizeB.h));
  }
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
