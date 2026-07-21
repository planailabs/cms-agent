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
  /** Marker index = the element's `data-cmsm` attribute, so the aligner can
   *  re-select it in the page to inject spacers before re-screenshotting. */
  i?: number;
  /** Bounding box (document-absolute CSS px): left, width, height. Enables the
   *  2-D rectangle-split layout (columns/cells), not just vertical position. */
  x?: number;
  w?: number;
  h?: number;
  /** Structural signature for container "layers" (tag + descendant-block
   *  shape, text-independent). Empty/absent for leaf blocks. Lets a section
   *  anchor by structure even when its text was reworded. */
  s?: string;
  /** Element id — a STABLE identifier: same id ⇒ same element, however much
   *  its text changed. Strongest match signal. Absent when the element has none. */
  id?: string;
  /** Nearest ancestor id (the leaf's "scope", e.g. its section) — leaves rarely
   *  have their own id but usually sit under one. Same scope + same tag boosts
   *  the match. Absent when no ancestor has an id. */
  sid?: string;
  /** Space-separated class list (mild identity signal). Absent when empty. */
  c?: string;
  /** Flex/grid cell key: "<container>/<childCount>#<cellIndex>" of the nearest
   *  flex/grid ancestor. Leaves in the same cell (card) share it; different
   *  columns of one grid differ — so a grid's columns never cross-match. */
  fx?: string;
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
 * translated (different words, same roles in the same order). Each marker also
 * carries its bounding box (x/w/h) so the renderer can partition a shot into
 * rectangles (columns/cells) and align each on its own — see compare/layout.
 * Markers are capped so the O(n·m) match stays bounded on huge pages.
 */
export const COLLECT_MARKERS_JS = `(function () {
  var LEAF = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,figure,img,td,th';
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
    var x = Math.round(r.left);
    var w = Math.round(r.width);
    var hgt = Math.round(r.height);
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
      // A table cell is the content unit — skip block leaves nested inside one
      // (the cell captures their text), so a cell isn't double-counted.
      var isCell = el.tagName === 'TD' || el.tagName === 'TH';
      if (!isCell && el.closest && el.closest('td,th')) continue;
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
    var mk = { k: key + '#' + n, y: y, x: x, w: w, h: hgt, s: sig, i: out.length };
    // Tag the element so the aligner can re-select it to inject spacers before
    // re-screenshotting (invisible; set before the shot). data-cmsm = marker i.
    try { el.setAttribute('data-cmsm', String(out.length)); } catch (e) {}
    if (el.id) mk.id = el.id;
    var cls = typeof el.className === 'string' ? el.className : '';
    if (cls) mk.c = cls.slice(0, 100);
    var scopeId = '';
    for (var pp = el.parentElement; pp; pp = pp.parentElement) {
      if (pp.id) { scopeId = pp.id; break; }
    }
    if (scopeId) mk.sid = scopeId;
    // Cell identity so a grid's/table's columns are distinct and never cross-
    // match. Tables: (row,col) of the enclosing cell. Flex/grid: the leaf's
    // index in the nearest flex/grid ancestor.
    var cell = el.closest ? el.closest('td,th') : null;
    if (cell) {
      var trow = cell.parentNode;
      var rowIx = trow && typeof trow.rowIndex === 'number' ? trow.rowIndex : 0;
      var tbl = cell.closest('table');
      var ttop = tbl ? Math.round(tbl.getBoundingClientRect().top + scrollY) : 0;
      mk.fx = 'T' + ttop + '/#r' + rowIx + 'c' + cell.cellIndex;
    } else {
      var child = el;
      for (var q = el.parentElement, depth = 0; q && depth < 8; q = q.parentElement, depth++) {
        var disp = '';
        try { disp = getComputedStyle(q).display; } catch (e) { disp = ''; }
        if (disp === 'flex' || disp === 'grid' || disp === 'inline-flex' || disp === 'inline-grid') {
          if (q.children.length > 1) {
            var ci = 0;
            for (var ki = 0; ki < q.children.length; ki++) { if (q.children[ki] === child) { ci = ki; break; } }
            mk.fx = (q.id || q.tagName) + '/' + q.children.length + '#' + ci;
          }
          break;
        }
        child = q;
      }
    }
    out.push(mk);
  }
  var root = document.scrollingElement || document.documentElement;
  return { h: Math.round(root.scrollHeight), m: out };
})()`;

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

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Word-set Jaccard similarity (0..1); 1 for identical text. */
const jaccard = (a: string, b: string): number => {
  if (a === b) return 1;
  const ta = new Set(tokenize(a));
  const tb = tokenize(b);
  if (ta.size === 0 && tb.length === 0) return 0;
  let inter = 0;
  const seen = new Set<string>();
  for (const t of tb) {
    if (ta.has(t) && !seen.has(t)) inter++;
    seen.add(t);
  }
  const uni = ta.size + seen.size - inter;
  return uni ? inter / uni : 0;
};

const parseKey = (k: string): { cont: boolean; tag: string; text: string } => {
  if (k.charCodeAt(0) === 35) return { cont: true, tag: k.replace(/#\d+$/, ''), text: '' };
  const c = k.indexOf(':');
  const h = k.lastIndexOf('#');
  return { cont: false, tag: c > 0 ? k.slice(0, c) : '', text: c >= 0 ? k.slice(c + 1, h > c ? h : k.length) : '' };
};

/** Jaccard over the two class lists (mild identity signal). */
const classSim = (a?: string, b?: string): number => {
  if (!a || !b) return 0;
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const seen = new Set<string>();
  let inter = 0;
  for (const t of b.split(/\s+/).filter(Boolean)) {
    if (!seen.has(t)) {
      if (ta.has(t)) inter++;
      seen.add(t);
    }
  }
  const uni = ta.size + seen.size - inter;
  return uni ? inter / uni : 0;
};

/**
 * Match degree between two markers, 0..1:
 *  - a shared, non-empty element id ⇒ 1 (STABLE identity — same element even if
 *    every word changed);
 *  - exact text ⇒ 1;
 *  - same tag ⇒ word-overlap (Jaccard), lifted a little when the class lists
 *    also overlap;
 *  - different element types (or container vs leaf) ⇒ 0; containers match on
 *    identical structure.
 */
export const similarity = (a: Marker, b: Marker): number => {
  if (a.k === b.k) return 1;
  const pa = parseKey(a.k);
  const pb = parseKey(b.k);
  if (pa.cont !== pb.cont) return 0;
  if (pa.cont) return pa.tag === pb.tag ? 0.8 : 0;
  if (pa.tag !== pb.tag) return 0; // tag is part of identity
  const text = jaccard(pa.text, pb.text);
  // Different columns of the SAME flex/grid are distinct — never let a section's
  // scope-id fold two columns together (that overlays a grid's cells).
  if (a.fx && b.fx && a.fx !== b.fx) {
    const ga = a.fx.slice(0, a.fx.indexOf('#'));
    const gb = b.fx.slice(0, b.fx.indexOf('#'));
    if (ga === gb) return Math.min(text, 0.3); // same grid, other cell → not it
  }
  if (a.id && a.id === b.id) return 1; // same tag + same stable id
  if (a.fx && a.fx === b.fx && a.sid === b.sid) return Math.min(1, 0.6 + 0.4 * text); // same cell
  // Stable identity from scope (section) + classes (semantic role). Same tag +
  // same section + same class ≈ the same element, so lift the score toward 1
  // even if every word changed; short of that, text carries it.
  const idBoost = (a.sid && a.sid === b.sid ? 0.5 : 0) + 0.5 * classSim(a.c, b.c);
  return Math.min(1, text + idBoost * (1 - text));
};

/** A matched pair (indices into a/b) with its match degree. */
export interface Match {
  ai: number;
  bi: number;
  score: number;
}
export interface Alignment {
  matches: Match[];
  onlyA: number[]; // present in a, missing from b (removed)
  onlyB: number[]; // present in b, missing from a (added)
}

/**
 * Order-preserving best-score alignment (Needleman–Wunsch): maximise the total
 * match degree, letting unmatched markers fall through as gaps ("missing
 * element, fill up") instead of forcing a positional pairing. Exact matches
 * dominate; a genuinely different element scores ~0 and is skipped rather than
 * mis-paired.
 */
export function alignMarkers(a: Marker[], b: Marker[]): Alignment {
  const n = a.length;
  const m = b.length;
  const dp: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + similarity(a[i - 1], b[j - 1]);
      dp[i][j] = Math.max(diag, dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matches: Match[] = [];
  const onlyA: number[] = [];
  const onlyB: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = similarity(a[i - 1], b[j - 1]);
    if (dp[i][j] === dp[i - 1][j - 1] + s) {
      matches.push({ ai: i - 1, bi: j - 1, score: s });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      onlyA.push(--i);
    } else {
      onlyB.push(--j);
    }
  }
  while (i > 0) onlyA.push(--i);
  while (j > 0) onlyB.push(--j);
  matches.reverse();
  onlyA.reverse();
  onlyB.reverse();
  return { matches, onlyA, onlyB };
}

/** Anchor score floor: below this a diagonal pairing is positional, not a
 *  content match, so it isn't used as an alignment breakpoint. */
export const ANCHOR_MIN = 0.5;

/** Aligned (yA,yB) breakpoints from the scored alignment — matches at or above
 *  ANCHOR_MIN, strictly increasing on both sides. */
export function computeAnchors(a: Marker[], b: Marker[]): Anchor[] {
  if (a.length === 0 || b.length === 0) return [];
  const { matches } = alignMarkers(a, b);
  const pairs = matches
    .filter((mm) => mm.score >= ANCHOR_MIN)
    .map((mm) => ({ a: a[mm.ai].y, b: b[mm.bi].y }));
  return strictlyIncreasing(pairs);
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
  return alignedSegmentsIn(anchors, 0, heightA, 0, heightB);
}

/** Aligned segments bracketed to an arbitrary [startA,endA]×[startB,endB]
 *  range — the 2-D layout aligns each rectangle within its own y-band. */
export function alignedSegmentsIn(
  anchors: Anchor[],
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): AlignedSegment[] {
  const inner = anchors.filter(
    (p) => p.a > startA && p.a < endA && p.b > startB && p.b < endB,
  );
  const b: Anchor[] = [{ a: startA, b: startB }, ...inner, { a: endA, b: endB }];
  const segs: AlignedSegment[] = [];
  for (let i = 1; i < b.length; i++) {
    const hA = b[i].a - b[i - 1].a;
    const hB = b[i].b - b[i - 1].b;
    if (hA <= 0 && hB <= 0) continue;
    segs.push({ topA: b[i - 1].a, topB: b[i - 1].b, hA, hB, h: Math.max(hA, hB) });
  }
  return segs;
}
