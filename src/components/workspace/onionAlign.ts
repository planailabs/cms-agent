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

const buildColumn = (src: string, segs: AlignedSegment[], side: 'a' | 'b', scale: number): HTMLElement => {
  const col = document.createElement('div');
  col.className = 'ws-onion__segments';
  for (const seg of segs) {
    const div = document.createElement('div');
    div.className = 'ws-onion__segment';
    const top = side === 'a' ? seg.topA : seg.topB;
    div.style.height = `${seg.h * scale}px`;
    div.style.backgroundImage = `url("${src}")`;
    div.style.backgroundSize = '100% auto';
    div.style.backgroundPosition = `0px ${-top * scale}px`;
    col.appendChild(div);
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

  const width = container.clientWidth;
  const sig = `${beforeImg.src}|${afterImg.src}|${width}`;
  if (container.dataset.alignSig === sig) return;

  const [a, b, size] = await Promise.all([
    fetchMarkers(beforeImg.src),
    fetchMarkers(afterImg.src),
    imageSize(beforeImg.src),
  ]);
  // Re-check: render passes may have replaced the DOM while we fetched
  if (!container.isConnected || container.clientWidth !== width) return;
  if (!a || !b || !size || size.w <= 0) {
    cleanup(container); // no markers → height mode for this pair
    return;
  }

  const segs = alignedSegments(computeAnchors(a.m, b.m), a.h, b.h);
  if (segs.length === 0) {
    cleanup(container);
    return;
  }
  const scale = width / size.w;

  for (const el of container.querySelectorAll('.ws-onion__segments')) el.remove();
  beforeWrap.appendChild(buildColumn(beforeImg.src, segs, 'a', scale));
  afterWrap.appendChild(buildColumn(afterImg.src, segs, 'b', scale));
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
