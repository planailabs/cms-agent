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
  /** Structural signature for container "layers" (tag + descendant-block
   *  shape, text-independent). Empty/absent for leaf blocks. Lets a section
   *  anchor by structure even when its text was reworded. */
  s?: string;
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
 *
 * Every marker in document order carries a content key `k` and a
 * text-independent structural signature `s`:
 *  - leaf blocks (headings, paragraphs, …) → k = text (exact identity); s =
 *    "<nearest-container-tag>/<tag>" (its structural role).
 *  - semantic containers (section/article/ul/…) → k = "#<structsig>"; s =
 *    the same structsig (tag + descendant-block shape).
 * The matcher uses k for exact content and s for structure, so a section AND
 * each element inside it still anchor 1:1 when the text was reworded or
 * translated (different words, same roles in the same order). Markers are
 * capped so the O(n·m) match stays bounded on huge pages.
 */
export const COLLECT_MARKERS_JS = `(function () {
  var LEAF = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,figure,img';
  var CONT = 'section,article,header,footer,main,nav,aside,ul,ol,figure,table,form,blockquote';
  var MAX = 800;
  var contTagOf = function (el) {
    for (var p = el.parentElement; p; p = p.parentElement) {
      if (p.matches(CONT)) return p.tagName;
    }
    return 'ROOT';
  };
  var counts = {};
  var out = [];
  var scrollY = window.scrollY || window.pageYOffset || 0;
  var els = document.querySelectorAll(LEAF + ',' + CONT);
  for (var i = 0; i < els.length && out.length < MAX; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.height <= 0) continue;
    var y = Math.round(r.top + scrollY);
    var kids = el.querySelectorAll(LEAF);
    var key, sig;
    if (el.matches(CONT) && kids.length >= 1) {
      // Container layer: signature from the descendant block shape only.
      sig = '';
      for (var j = 0; j < kids.length && j < 24; j++) {
        var kt = kids[j].tagName;
        sig += kt.charAt(0) + (kt.length > 1 ? kt.charAt(kt.length - 1) : '');
      }
      sig = el.tagName + '/' + kids.length + '/' + sig;
      key = '#' + sig;
    } else if (el.matches(LEAF)) {
      // Leaf block: exact content identity from its text (src for images);
      // structural role = its nearest semantic container + its own tag.
      var txt = el.tagName === 'IMG'
        ? (el.getAttribute('src') || '')
        : (el.textContent || '');
      txt = txt.replace(/\\s+/g, ' ').trim().slice(0, 80);
      if (!txt) continue;
      key = el.tagName + ':' + txt;
      sig = contTagOf(el) + '/' + el.tagName;
    } else {
      continue;
    }
    var n = counts[key] = (counts[key] || 0) + 1;
    out.push({ k: key + '#' + n, y: y, s: sig });
  }
  var root = document.scrollingElement || document.documentElement;
  return { h: Math.round(root.scrollHeight), m: out };
})()`;

/** LCS over a chosen marker key → raw matched (yA,yB) pairs in order. */
function lcsPairs(a: Marker[], b: Marker[], key: (m: Marker) => string): Anchor[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const ka = a.map(key);
  const kb = b.map(key);
  // DP table of LCS lengths (n·m is bounded by the collector's MAX cap)
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Anchor[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      pairs.push({ a: a[i].y, b: b[j].y });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Keep only anchors strictly increasing in y on BOTH sides (a moved block
 *  must not fold the mapping back on itself). */
function strictlyIncreasing(pairs: Anchor[]): Anchor[] {
  const out: Anchor[] = [];
  for (const p of pairs) {
    const last = out[out.length - 1];
    if (!last || (p.a > last.a && p.b > last.b)) out.push(p);
  }
  return out;
}

/** Insert `extra` anchors into `base` only where they fall strictly between
 *  consecutive base anchors on BOTH axes — preserves strict monotonicity and
 *  keeps the higher-confidence base anchors authoritative. */
function mergeAnchors(base: Anchor[], extra: Anchor[]): Anchor[] {
  if (extra.length === 0) return base;
  const result = base.slice();
  for (const e of [...extra].sort((x, y) => x.a - y.a)) {
    let i = 0;
    while (i < result.length && result[i].a < e.a) i++;
    const prev = result[i - 1];
    const next = result[i];
    if ((!prev || (e.a > prev.a && e.b > prev.b)) && (!next || (e.a < next.a && e.b < next.b))) {
      result.splice(i, 0, e);
    }
  }
  return result;
}

/** Leaf markers key by text; container markers key by "#<structsig>". */
const isLeaf = (m: Marker): boolean => m.k.charCodeAt(0) !== 35 /* '#' */;

/**
 * Order-preserving content matches, in two layers:
 *  1. exact leaf text — high-confidence anchors;
 *  2. structural signatures (container structsig + each leaf's role) — merged
 *     into the gaps layer 1 left open, so reworded / translated content still
 *     anchors section-by-section AND element-by-element (same roles, same
 *     order, different words).
 * Both passes are LCS + strict-increasing filtered; layer 2 only fills space
 * layer 1 left open. Markers without `s` (old caches) skip layer 2 → identical
 * to the previous behaviour.
 */
export function computeAnchors(a: Marker[], b: Marker[]): Anchor[] {
  const base = strictlyIncreasing(lcsPairs(a.filter(isLeaf), b.filter(isLeaf), (m) => m.k));
  const sa = a.filter((m) => m.s);
  const sb = b.filter((m) => m.s);
  if (sa.length === 0 || sb.length === 0) return base;
  const structural = strictlyIncreasing(lcsPairs(sa, sb, (m) => m.s!));
  return mergeAnchors(base, structural);
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
