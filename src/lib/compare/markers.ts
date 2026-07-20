/**
 * Content markers for exact before/after comparisons (onion spacing) and
 * content-aligned scroll sync.
 *
 * Design choice: markers are COMPUTED at runtime by one shared collector —
 * never injected into served/built HTML. The screenshot engine evaluates
 * COLLECT_MARKERS_JS in playwright before each capture (persisted as
 * `<shot>.markers.json`); the side-by-side diff iframes evaluate the same
 * expression through the injected bootstrap's cms:eval channel. Rejected
 * alternatives: build-time attributes (requires modifying every managed
 * site's build) and DOM-injected markers (mutates the page under test).
 *
 * Identity: tag + whitespace-normalized text prefix (src for images), with
 * an occurrence counter for duplicates — stable across versions where the
 * content is unchanged. Matching is an LCS over the two key sequences
 * (order-preserving, no crossing alignments), then filtered to strictly
 * increasing y on both sides.
 */

export interface Marker {
  /** Content-identity key (tag + text prefix + occurrence). */
  k: string;
  /** Document-absolute top in CSS px. */
  y: number;
}

export interface MarkerDoc {
  /** Full scroll height of the document at capture time. */
  h: number;
  m: Marker[];
}

/** Matched content anchor: the same content at yA (before) and yB (after). */
export interface Anchor {
  a: number;
  b: number;
}

/**
 * Self-contained expression — evaluates to a MarkerDoc. ES5, no deps: runs
 * via playwright page.evaluate AND the injected bootstrap's eval channel.
 */
export const COLLECT_MARKERS_JS = `(function () {
  var SEL = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,figure,img';
  var counts = {};
  var out = [];
  var els = document.querySelectorAll(SEL);
  var scrollY = window.scrollY || window.pageYOffset || 0;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.height <= 0) continue;
    var txt = el.tagName === 'IMG'
      ? (el.getAttribute('src') || '')
      : (el.textContent || '');
    txt = txt.replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (!txt) continue;
    var key = el.tagName + ':' + txt;
    var n = counts[key] = (counts[key] || 0) + 1;
    out.push({ k: key + '#' + n, y: Math.round(r.top + scrollY) });
  }
  var root = document.scrollingElement || document.documentElement;
  return { h: Math.round(root.scrollHeight), m: out };
})()`;

/**
 * Order-preserving content matches between two marker lists: classic LCS
 * over the keys, then filtered to strictly increasing y on BOTH sides (a
 * moved block must not fold the mapping back on itself).
 */
export function computeAnchors(a: Marker[], b: Marker[]): Anchor[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  // DP table of LCS lengths (n·m is bounded by the collector's element set)
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i].k === b[j].k ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Anchor[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].k === b[j].k) {
      pairs.push({ a: a[i].y, b: b[j].y });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const monotonic: Anchor[] = [];
  for (const p of pairs) {
    const last = monotonic[monotonic.length - 1];
    if (!last || (p.a > last.a && p.b > last.b)) monotonic.push(p);
  }
  return monotonic;
}

/** Anchors bracketed with document start/end — the piecewise breakpoints. */
export function bracketAnchors(anchors: Anchor[], heightA: number, heightB: number): Anchor[] {
  const inner = anchors.filter((p) => p.a > 0 && p.a < heightA && p.b > 0 && p.b < heightB);
  return [{ a: 0, b: 0 }, ...inner, { a: heightA, b: heightB }];
}

/** Map a document position in A to the content-equivalent position in B
 *  (piecewise-linear between bracketed anchors; clamps outside). */
export function mapPosition(topA: number, bracketed: Anchor[]): number {
  if (bracketed.length < 2) return topA;
  if (topA <= bracketed[0].a) return bracketed[0].b;
  for (let i = 1; i < bracketed.length; i++) {
    const lo = bracketed[i - 1];
    const hi = bracketed[i];
    if (topA <= hi.a) {
      const span = hi.a - lo.a;
      const t = span > 0 ? (topA - lo.a) / span : 0;
      return lo.b + t * (hi.b - lo.b);
    }
  }
  return bracketed[bracketed.length - 1].b;
}

export interface AlignedSegment {
  /** Slice start in each source document (CSS px). */
  topA: number;
  topB: number;
  /** Slice heights in each source; `h` is the aligned row height. */
  hA: number;
  hB: number;
  h: number;
}

/**
 * Segments between consecutive anchors, each padded to the taller side —
 * rendering both columns segment-by-segment puts identical content at
 * identical y, with visible blank space where one side added content.
 */
export function alignedSegments(
  anchors: Anchor[],
  heightA: number,
  heightB: number,
): AlignedSegment[] {
  const b = bracketAnchors(anchors, heightA, heightB);
  const segs: AlignedSegment[] = [];
  for (let i = 1; i < b.length; i++) {
    const hA = b[i].a - b[i - 1].a;
    const hB = b[i].b - b[i - 1].b;
    if (hA <= 0 && hB <= 0) continue;
    segs.push({ topA: b[i - 1].a, topB: b[i - 1].b, hA, hB, h: Math.max(hA, hB) });
  }
  return segs;
}
