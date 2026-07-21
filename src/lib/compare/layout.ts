/**
 * 2-D content-aligned layout. Instead of slicing a shot into full-width
 * horizontal bands, recursively partition it into RECTANGLES by guillotine
 * cuts — straight full-span gaps between content boxes — then align each leaf
 * rectangle's content 1-D. Grids need no special case: a row of cards has
 * vertical gaps → split into column rectangles; each column then splits by its
 * own horizontal gaps → every box expands on its own side.
 *
 * The two shots are partitioned independently and their trees matched by shape
 * (same cut direction + child count); a structural mismatch falls back to
 * aligning that region as one 1-D leaf, so it degrades to the old behaviour
 * rather than mis-slicing.
 *
 * All coordinates are natural (source-image) CSS px. X-ranges are taken from
 * the "before" shot — the two pages share a layout width; only heights differ.
 */
import {
  ANCHOR_MIN,
  alignMarkers,
  alignedSegmentsIn,
  bracketAnchors,
  computeAnchors,
  mapPosition,
  type AlignedSegment,
  type Marker,
} from './markers';

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Box extends Bounds {
  m: Marker;
}

type Part =
  | { kind: 'leaf'; boxes: Box[]; b: Bounds }
  | { kind: 'split'; dir: 'h' | 'v'; gap: number; children: [Part, Part]; b: Bounds };

/** A node of the aligned render tree. `h` is the aligned height (identical on
 *  both sides); leaves carry per-side slice heights via AlignedSegment. */
export interface ANode {
  x0: number;
  w: number;
  h: number;
  kind: 'leaf' | 'row' | 'col';
  segs?: AlignedSegment[]; // leaf: 1-D slices within [x0, x0+w]
  children?: ANode[]; // row = side-by-side, col = stacked
}

const MIN_GAP = 10; // px: a guillotine cut needs at least this clear gap

const isContainer = (m: Marker): boolean => m.k.charCodeAt(0) === 35; // "#…" structsig
const hasBox = (m: Marker): boolean => m.x !== undefined && m.w !== undefined && m.h !== undefined;

const boxOf = (m: Marker): Box | null => {
  if (m.x === undefined || m.w === undefined || m.h === undefined) return null;
  return { x0: m.x, y0: m.y, x1: m.x + m.w, y1: m.y + m.h, m };
};

/** Partition both shots into rectangle trees over a shared width (the two
 *  pages share a layout width; only heights differ). Null if either lacks
 *  bounding boxes (old marker caches). */
const partitionPair = (
  a: Marker[],
  ah: number,
  b: Marker[],
  bh: number,
): { pa: Part; pb: Part } | null => {
  const boxesA = a.filter((m) => !isContainer(m)).map(boxOf).filter((x): x is Box => x !== null);
  const boxesB = b.filter((m) => !isContainer(m)).map(boxOf).filter((x): x is Box => x !== null);
  if (boxesA.length === 0 || boxesB.length === 0) return null;
  const w = Math.max(...boxesA.map((x) => x.x1), ...boxesB.map((x) => x.x1));
  return {
    pa: partition(boxesA, { x0: 0, y0: 0, x1: w, y1: ah }),
    pb: partition(boxesB, { x0: 0, y0: 0, x1: w, y1: bh }),
  };
};

/** Largest full-span gap between boxes in one axis; null if none ≥ MIN_GAP. */
const axisCut = (
  boxes: Box[],
  lo: (b: Box) => number,
  hi: (b: Box) => number,
): { pos: number; gap: number } | null => {
  const sorted = [...boxes].sort((p, q) => lo(p) - lo(q));
  let running = -Infinity;
  let best: { pos: number; gap: number } | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && running > -Infinity) {
      const gap = lo(sorted[i]) - running;
      if (gap >= MIN_GAP && (!best || gap > best.gap)) {
        best = { pos: running + gap / 2, gap };
      }
    }
    running = Math.max(running, hi(sorted[i]));
  }
  return best;
};

const partition = (boxes: Box[], b: Bounds): Part => {
  if (boxes.length <= 1) return { kind: 'leaf', boxes, b };
  const h = axisCut(boxes, (x) => x.y0, (x) => x.y1); // horizontal cut (stack)
  const v = axisCut(boxes, (x) => x.x0, (x) => x.x1); // vertical cut (columns)
  // Take the cleaner (wider) separation; recursion handles the rest.
  const pick =
    v && (!h || v.gap >= h.gap)
      ? { dir: 'v' as const, pos: v.pos, gap: v.gap }
      : h
        ? { dir: 'h' as const, pos: h.pos, gap: h.gap }
        : null;
  if (!pick) return { kind: 'leaf', boxes, b };

  const isV = pick.dir === 'v';
  const key = (bx: Box) => (isV ? bx.x1 : bx.y1);
  const first: Box[] = [];
  const second: Box[] = [];
  for (const bx of boxes) (key(bx) <= pick.pos ? first : second).push(bx);
  if (first.length === 0 || second.length === 0) return { kind: 'leaf', boxes, b };

  const b1: Bounds = isV ? { ...b, x1: pick.pos } : { ...b, y1: pick.pos };
  const b2: Bounds = isV ? { ...b, x0: pick.pos } : { ...b, y0: pick.pos };
  return { kind: 'split', dir: pick.dir, gap: pick.gap, children: [partition(first, b1), partition(second, b2)], b };
};

/** All leaf markers of a part, in document order (for the 1-D fallback). */
const leavesOf = (p: Part): Box[] =>
  p.kind === 'leaf' ? p.boxes : [...leavesOf(p.children[0]), ...leavesOf(p.children[1])];

/** Align one leaf rectangle: 1-D over its boxes' markers, within its y-band. */
const alignLeaf = (pa: Part, pb: Part): ANode => {
  const ba = leavesOf(pa).sort((p, q) => p.y0 - q.y0);
  const bb = leavesOf(pb).sort((p, q) => p.y0 - q.y0);
  const boundsA = pa.b;
  const boundsB = pb.b;
  const segs = alignedSegmentsIn(
    computeAnchors(ba.map((x) => x.m), bb.map((x) => x.m)),
    boundsA.y0,
    boundsA.y1,
    boundsB.y0,
    boundsB.y1,
  );
  const h = segs.reduce((s, x) => s + x.h, 0);
  return { kind: 'leaf', x0: boundsA.x0, w: boundsA.x1 - boundsA.x0, h, segs };
};

const keyTag = (k: string): string => {
  const c = k.indexOf(':');
  return c > 0 ? k.slice(0, c) : k;
};

/** Structural similarity: multiset Jaccard of the two regions' element tags.
 *  Corresponds even when all the text changed (same section, same shape). */
const structSim = (pa: Part, pb: Part): number => {
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  let na = 0;
  let nb = 0;
  for (const x of leavesOf(pa)) {
    const t = keyTag(x.m.k);
    ca.set(t, (ca.get(t) ?? 0) + 1);
    na++;
  }
  for (const x of leavesOf(pb)) {
    const t = keyTag(x.m.k);
    cb.set(t, (cb.get(t) ?? 0) + 1);
    nb++;
  }
  if (na === 0 || nb === 0) return 0;
  let inter = 0;
  for (const [t, n] of ca) inter += Math.min(n, cb.get(t) ?? 0);
  const uni = na + nb - inter;
  return uni ? inter / uni : 0;
};

/**
 * Content similarity between two child rectangles: text overlap, plus a
 * structure bonus that only counts for RICH blocks. A rich structure matching
 * (a whole section: heading + several paragraphs) is strong evidence the blocks
 * correspond even when every word changed; two lone same-tag paragraphs look
 * structurally identical but that's no evidence at all, so there text decides —
 * keeping insertion detection alive.
 */
const CHILD_MIN = 0.3;
const childSim = (pa: Part, pb: Part): number => {
  const ma = leavesOf(pa).map((x) => x.m);
  const mb = leavesOf(pb).map((x) => x.m);
  if (ma.length === 0 || mb.length === 0) return 0;
  const good = alignMarkers(ma, mb).matches.filter((mm) => mm.score >= 0.5).length;
  const textSim = good / Math.max(ma.length, mb.length);
  const richness = Math.min(1, (Math.min(ma.length, mb.length) - 1) / 3); // 1 elem → 0
  return Math.min(1, textSim + 0.5 * structSim(pa, pb) * richness);
};

/** Order-preserving alignment of two sibling lists by content similarity, with
 *  gaps for added/removed children (a sub-CHILD_MIN pairing is a gap, not a
 *  forced match). */
const alignChildren = (as: Part[], bs: Part[]): Array<[Part | null, Part | null]> => {
  const n = as.length;
  const m = bs.length;
  const eff = (i: number, j: number): number => {
    const s = childSim(as[i], bs[j]);
    return s >= CHILD_MIN ? s : -1; // sub-threshold → gaps beat a forced pairing
  };
  const dp: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(dp[i - 1][j - 1] + eff(i - 1, j - 1), dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: Array<[Part | null, Part | null]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (dp[i][j] === dp[i - 1][j - 1] + eff(i - 1, j - 1)) {
      out.push([as[i - 1], bs[j - 1]]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push([as[--i], null]);
    } else {
      out.push([null, bs[--j]]);
    }
  }
  while (i > 0) out.push([as[--i], null]);
  while (j > 0) out.push([null, bs[--j]]);
  out.reverse();
  return out;
};

/** A child present on only one side: its content on that side, a filler of the
 *  same height on the other — a hierarchy-correct filler exactly where the
 *  insertion/removal is, not tacked onto the end. */
const spanNode = (p: Part, side: 'a' | 'b'): ANode => {
  const top = p.b.y0;
  const height = p.b.y1 - p.b.y0;
  const seg: AlignedSegment =
    side === 'a'
      ? { topA: top, topB: 0, hA: height, hB: 0, h: height }
      : { topA: 0, topB: top, hA: 0, hB: height, h: height };
  return { kind: 'leaf', x0: p.b.x0, w: p.b.x1 - p.b.x0, h: height, segs: [seg] };
};

/** Flatten a run of same-direction splits at the SAME gap level into one flat
 *  sibling list. The partition is binary, so N blocks at one level nest as
 *  (1,(2,(3,…))) — but a smaller inner gap (within a block) must NOT flatten,
 *  or blocks lose their grouping. Flatten only child splits whose gap is a
 *  meaningful fraction of this level's gap. */
const FLATTEN_RATIO = 0.5;
const flattenChildren = (p: Part & { kind: 'split' }): Part[] => {
  const out: Part[] = [];
  const walk = (q: Part): void => {
    if (q.kind === 'split' && q.dir === p.dir && q.gap >= FLATTEN_RATIO * p.gap) {
      walk(q.children[0]);
      walk(q.children[1]);
    } else {
      out.push(q);
    }
  };
  walk(p.children[0]);
  walk(p.children[1]);
  return out;
};

/** Match two partition trees into an aligned render tree. */
const matchAlign = (pa: Part, pb: Part): ANode => {
  if (pa.kind === 'split' && pb.kind === 'split' && pa.dir === pb.dir) {
    // Align siblings by content (not index) so an inserted/removed block gets a
    // filler in the right place instead of shifting everything after it.
    const fa = flattenChildren(pa);
    const fb = flattenChildren(pb);
    const pairs = alignChildren(fa, fb);
    // If most siblings don't correspond, this region is a rewrite, not an edit —
    // overlaying it as one rectangle (height = max) is right; stacking one-sided
    // halves would double the height into a mess.
    const matched = pairs.filter(([x, y]) => x && y).length;
    if (matched < 0.5 * Math.max(fa.length, fb.length)) return alignLeaf(pa, pb);
    const children = pairs.map(([ca, cb]) =>
      ca && cb ? matchAlign(ca, cb) : ca ? spanNode(ca, 'a') : spanNode(cb!, 'b'),
    );
    const x0 = pa.b.x0;
    const w = pa.b.x1 - pa.b.x0;
    if (pa.dir === 'v') {
      const h = Math.max(...children.map((c) => c.h)); // columns: pad to tallest
      return { kind: 'row', x0, w, h, children };
    }
    const h = children.reduce((s, c) => s + c.h, 0); // stacked: heights add up
    return { kind: 'col', x0, w, h, children };
  }
  return alignLeaf(pa, pb);
};

/**
 * Build the aligned render tree for two shots. Returns null when the shots
 * lack bounding boxes (old marker caches) so the caller can fall back to the
 * plain 1-D path.
 */
export const buildLayout = (
  a: Marker[],
  ah: number,
  b: Marker[],
  bh: number,
): ANode | null => {
  const pair = partitionPair(a, ah, b, bh);
  return pair ? matchAlign(pair.pa, pair.pb) : null;
};

// ── Box-diff highlights ────────────────────────────────────────────────────

export interface DiffBox {
  kind: 'added' | 'removed' | 'changed';
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Content-box diff for rectangle highlights, in AFTER-shot coordinates:
 *  - added   → a leaf in a block present only in b (green),
 *  - changed → a matched leaf whose text/size differs (amber),
 *  - removed → a leaf in a block present only in a, y mapped to b-space (red).
 *
 * Uses the SAME structure-aware block matching as the layout: blocks correspond
 * by structure+text (so a heavily-edited block is "changed", not add+remove,
 * and an inserted block is "added", not a shifted mis-match); only WITHIN a
 * matched block are markers paired by text to flag the changed ones. Semantic,
 * so anti-aliasing / cross-browser noise never lights up. [] without boxes.
 */
export const boxDiff = (a: Marker[], ah: number, b: Marker[], bh: number): DiffBox[] => {
  const pair = partitionPair(a, ah, b, bh);
  if (!pair) return [];

  const added: Marker[] = [];
  const removed: Marker[] = [];
  const changed: Marker[] = [];
  // Corresponding blocks: pair markers by text; a low score still means the
  // same element edited (the block already matched), so it's "changed".
  // "changed" is a CONTENT question (did the text/tag change?), separate from
  // "did they correspond?" — identity (id/scope/class) can make a heavily-edited
  // element score ~1, so compare the content key, not the match score.
  const baseKey = (k: string): string => k.replace(/#\d+$/, '');
  const leafDiff = (na: Part, nb: Part): void => {
    const ma = leavesOf(na).map((x) => x.m);
    const mb = leavesOf(nb).map((x) => x.m);
    const { matches, onlyA, onlyB } = alignMarkers(ma, mb);
    for (const mm of matches) {
      if (baseKey(ma[mm.ai].k) !== baseKey(mb[mm.bi].k)) changed.push(mb[mm.bi]);
    }
    for (const i of onlyB) added.push(mb[i]);
    for (const i of onlyA) removed.push(ma[i]);
  };
  const walk = (na: Part, nb: Part): void => {
    if (na.kind === 'split' && nb.kind === 'split' && na.dir === nb.dir) {
      const fa = flattenChildren(na);
      const fb = flattenChildren(nb);
      const pairs = alignChildren(fa, fb);
      const matched = pairs.filter(([x, y]) => x && y).length;
      if (matched < 0.5 * Math.max(fa.length, fb.length)) {
        leafDiff(na, nb);
        return;
      }
      for (const [ca, cb] of pairs) {
        if (ca && cb) walk(ca, cb);
        else if (ca) for (const bx of leavesOf(ca)) removed.push(bx.m);
        else for (const bx of leavesOf(cb!)) added.push(bx.m);
      }
      return;
    }
    leafDiff(na, nb);
  };
  walk(pair.pa, pair.pb);

  const out: DiffBox[] = [];
  for (const m of added) if (hasBox(m)) out.push({ kind: 'added', x: m.x!, y: m.y, w: m.w!, h: m.h! });
  for (const m of changed) if (hasBox(m)) out.push({ kind: 'changed', x: m.x!, y: m.y, w: m.w!, h: m.h! });
  if (removed.length) {
    const bracketed = bracketAnchors(computeAnchors(a, b), ah, bh);
    for (const m of removed) {
      if (hasBox(m)) out.push({ kind: 'removed', x: m.x!, y: mapPosition(m.y, bracketed), w: m.w!, h: m.h! });
    }
  }
  return out;
};

// ── Spacing plan (DOM filler injection) ────────────────────────────────────

/** One spacer to inject before re-screenshotting. `px` is the gap height.
 *  mode 'el' inserts before the element (flow / inside a cell); mode 'grid'
 *  inserts before the element's flex/grid container (pushes a whole grid). */
export interface Spacer {
  i: number;
  px: number;
  mode: 'el' | 'grid';
}
export interface SpacingPlan {
  a: Spacer[];
  b: Spacer[];
}

/**
 * Turn the aligned layout into DOM spacer injections for each side: instead of
 * slicing the shot on a canvas, push the real page's elements down with filler
 * elements and re-screenshot. Walks the same partition as buildLayout; within a
 * matched leaf region the anchors give inline gaps, one-sided blocks push the
 * OTHER side (pending), and a grid row's incoming gap pushes the whole grid.
 */
export const spacingPlan = (a: Marker[], ah: number, b: Marker[], bh: number): SpacingPlan => {
  const pair = partitionPair(a, ah, b, bh);
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  if (!pair) return { a: A, b: B };

  const push = (list: Spacer[], i: number | undefined, px: number, mode: 'el' | 'grid'): void => {
    if (i !== undefined && px > 0.5) list.push({ i, px: Math.round(px), mode });
  };
  const firstLeaf = (p: Part): Box | undefined =>
    leavesOf(p).slice().sort((x, y) => x.y0 - y.y0)[0];
  const heightOf = (p: Part): number => p.b.y1 - p.b.y0;

  // Returns leftover trailing pending [A,B] (the gap after the last anchor down
  // to the region bottom, e.g. content appended at the end) to carry forward.
  const leafRegion = (na: Part, nb: Part, pendA: number, pendB: number): [number, number] => {
    const ba = leavesOf(na).slice().sort((x, y) => x.y0 - y.y0);
    const bb = leavesOf(nb).slice().sort((x, y) => x.y0 - y.y0);
    if (ba[0]) push(A, ba[0].m.i, pendA, 'el'); // flow push of this region
    if (bb[0]) push(B, bb[0].m.i, pendB, 'el');
    const anchors = alignMarkers(ba.map((x) => x.m), bb.map((x) => x.m)).matches.filter(
      (m) => m.score >= ANCHOR_MIN,
    );
    let pYA = na.b.y0;
    let pYB = nb.b.y0;
    for (const an of anchors) {
      const eA = ba[an.ai];
      const eB = bb[an.bi];
      const gapA = eA.y0 - pYA;
      const gapB = eB.y0 - pYB;
      const h = Math.max(gapA, gapB);
      push(A, eA.m.i, h - gapA, 'el'); // inline gap before this anchor
      push(B, eB.m.i, h - gapB, 'el');
      pYA = eA.y0;
      pYB = eB.y0;
    }
    const trailA = Math.max(0, na.b.y1 - pYA);
    const trailB = Math.max(0, nb.b.y1 - pYB);
    const h = Math.max(trailA, trailB);
    return [h - trailA, h - trailB];
  };

  // Stacked flow: pending threads through siblings. Returns leftover pending.
  const walk = (na: Part, nb: Part, pendA: number, pendB: number): [number, number] => {
    if (na.kind === 'split' && nb.kind === 'split' && na.dir === nb.dir) {
      const fa = flattenChildren(na);
      const fb = flattenChildren(nb);
      const pairs = alignChildren(fa, fb);
      const matched = pairs.filter(([x, y]) => x && y).length;
      if (matched < 0.5 * Math.max(fa.length, fb.length)) {
        return leafRegion(na, nb, pendA, pendB);
      }
      if (na.dir === 'v') {
        // Columns: push the whole grid down once, then each column is its own
        // vertical flow (fresh pending, no cross-column carry).
        const fla = firstLeaf(na);
        const flb = firstLeaf(nb);
        if (fla) push(A, fla.m.i, pendA, 'grid');
        if (flb) push(B, flb.m.i, pendB, 'grid');
        for (const [ca, cb] of pairs) if (ca && cb) walk(ca, cb, 0, 0);
        return [0, 0];
      }
      // Stacked column of blocks.
      let pA = pendA;
      let pB = pendB;
      for (const [ca, cb] of pairs) {
        if (ca && cb) [pA, pB] = walk(ca, cb, pA, pB);
        else if (ca) pB += heightOf(ca); // removed block → gap on B
        else pA += heightOf(cb!); // added block → gap on A
      }
      return [pA, pB];
    }
    return leafRegion(na, nb, pendA, pendB);
  };

  walk(pair.pa, pair.pb, 0, 0);
  return { a: A, b: B };
};
