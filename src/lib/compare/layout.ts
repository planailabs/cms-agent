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
} from "./markers";

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
  | { kind: "leaf"; boxes: Box[]; b: Bounds }
  | {
      kind: "split";
      dir: "h" | "v";
      gap: number;
      children: [Part, Part];
      b: Bounds;
    };

/** A node of the aligned render tree. `h` is the aligned height (identical on
 *  both sides); leaves carry per-side slice heights via AlignedSegment. */
export interface ANode {
  x0: number;
  w: number;
  h: number;
  kind: "leaf" | "row" | "col";
  segs?: AlignedSegment[]; // leaf: 1-D slices within [x0, x0+w]
  children?: ANode[]; // row = side-by-side, col = stacked
}

const MIN_GAP = 10; // px: a guillotine cut needs at least this clear gap

const isContainer = (m: Marker): boolean => m.k.charCodeAt(0) === 35; // "#…" structsig
const hasBox = (m: Marker): boolean =>
  m.x !== undefined && m.w !== undefined && m.h !== undefined;

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
  const boxesA = a
    .filter((m) => !isContainer(m) && !m.v && !m.na)
    .map(boxOf)
    .filter((x): x is Box => x !== null);
  const boxesB = b
    .filter((m) => !isContainer(m) && !m.v && !m.na)
    .map(boxOf)
    .filter((x): x is Box => x !== null);
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
  if (boxes.length <= 1) return { kind: "leaf", boxes, b };
  const h = axisCut(
    boxes,
    (x) => x.y0,
    (x) => x.y1,
  ); // horizontal cut (stack)
  const v = axisCut(
    boxes,
    (x) => x.x0,
    (x) => x.x1,
  ); // vertical cut (columns)
  // Take the cleaner (wider) separation; recursion handles the rest. A grid,
  // though, has full-span gaps BOTH ways and flows row-major (align-items:
  // stretch → a row's cells share top & height), so cut its rows first: then a
  // row-height change or an add/remove propagates down as one unit instead of
  // desyncing independently-aligned columns. Detect a grid by its cells (`fx`)
  // and prefer the row cut whenever both exist — even when the column gap is the
  // wider one (e.g. gap: 12px 32px). Otherwise (incidental columns) take the
  // wider gap, and break an exact tie toward rows.
  const preferH = !!h && (!v || h.gap >= v.gap);
  const pick = preferH
    ? { dir: "h" as const, pos: h!.pos, gap: h!.gap }
    : v
      ? { dir: "v" as const, pos: v.pos, gap: v.gap }
      : null;
  if (!pick) return { kind: "leaf", boxes, b };

  const isV = pick.dir === "v";
  const key = (bx: Box) => (isV ? bx.x1 : bx.y1);
  const first: Box[] = [];
  const second: Box[] = [];
  for (const bx of boxes) (key(bx) <= pick.pos ? first : second).push(bx);
  if (first.length === 0 || second.length === 0)
    return { kind: "leaf", boxes, b };

  const b1: Bounds = isV ? { ...b, x1: pick.pos } : { ...b, y1: pick.pos };
  const b2: Bounds = isV ? { ...b, x0: pick.pos } : { ...b, y0: pick.pos };
  return {
    kind: "split",
    dir: pick.dir,
    gap: pick.gap,
    children: [partition(first, b1), partition(second, b2)],
    b,
  };
};

/** All leaf markers of a part, in document order (for the 1-D fallback). */
const leavesOf = (p: Part): Box[] =>
  p.kind === "leaf"
    ? p.boxes
    : [...leavesOf(p.children[0]), ...leavesOf(p.children[1])];

/** Align one leaf rectangle: 1-D over its boxes' markers, within its y-band. */
const alignLeaf = (pa: Part, pb: Part): ANode => {
  const ba = leavesOf(pa).sort((p, q) => p.y0 - q.y0);
  const bb = leavesOf(pb).sort((p, q) => p.y0 - q.y0);
  const boundsA = pa.b;
  const boundsB = pb.b;
  const segs = alignedSegmentsIn(
    computeAnchors(
      ba.map((x) => x.m),
      bb.map((x) => x.m),
    ),
    boundsA.y0,
    boundsA.y1,
    boundsB.y0,
    boundsB.y1,
  );
  const h = segs.reduce((s, x) => s + x.h, 0);
  return { kind: "leaf", x0: boundsA.x0, w: boundsA.x1 - boundsA.x0, h, segs };
};

const keyTag = (k: string): string => {
  const c = k.indexOf(":");
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
  // Preserve match strength: repeated cards often share the same classes/cell
  // roles, but those weak structural matches must not tie exact card content.
  // Counting every >=0.5 match as 1 made an insertion look like a rewrite of
  // the card at the same index, suppressing the one-sided filler.
  const matchedScore = alignMarkers(ma, mb).matches.reduce(
    (sum, mm) => sum + (mm.score >= ANCHOR_MIN ? mm.score : 0),
    0,
  );
  const textSim = matchedScore / Math.max(ma.length, mb.length);
  const richness = Math.min(1, (Math.min(ma.length, mb.length) - 1) / 3); // 1 elem → 0
  return Math.min(1, textSim + 0.5 * structSim(pa, pb) * richness);
};

/** Order-preserving alignment of two sibling lists by content similarity, with
 *  gaps for added/removed children (a sub-CHILD_MIN pairing is a gap, not a
 *  forced match). */
const alignChildren = (
  as: Part[],
  bs: Part[],
): Array<[Part | null, Part | null]> => {
  const n = as.length;
  const m = bs.length;
  const eff = (i: number, j: number): number => {
    const s = childSim(as[i], bs[j]);
    return s >= CHILD_MIN ? s : -1; // sub-threshold → gaps beat a forced pairing
  };
  const dp: Float64Array[] = Array.from(
    { length: n + 1 },
    () => new Float64Array(m + 1),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(
        dp[i - 1][j - 1] + eff(i - 1, j - 1),
        dp[i - 1][j],
        dp[i][j - 1],
      );
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
const spanNode = (p: Part, side: "a" | "b"): ANode => {
  const top = p.b.y0;
  const height = p.b.y1 - p.b.y0;
  const seg: AlignedSegment =
    side === "a"
      ? { topA: top, topB: 0, hA: height, hB: 0, h: height }
      : { topA: 0, topB: top, hA: 0, hB: height, h: height };
  return {
    kind: "leaf",
    x0: p.b.x0,
    w: p.b.x1 - p.b.x0,
    h: height,
    segs: [seg],
  };
};

/** Flatten a run of same-direction splits at the SAME gap level into one flat
 *  sibling list. The partition is binary, so N blocks at one level nest as
 *  (1,(2,(3,…))) — but a smaller inner gap (within a block) must NOT flatten,
 *  or blocks lose their grouping. Flatten only child splits whose gap is a
 *  meaningful fraction of this level's gap. */
const FLATTEN_RATIO = 0.5;
const flattenChildren = (p: Part & { kind: "split" }): Part[] => {
  const out: Part[] = [];
  const walk = (q: Part): void => {
    if (
      q.kind === "split" &&
      q.dir === p.dir &&
      q.gap >= FLATTEN_RATIO * p.gap
    ) {
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
  if (pa.kind === "split" && pb.kind === "split" && pa.dir === pb.dir) {
    // Align siblings by content (not index) so an inserted/removed block gets a
    // filler in the right place instead of shifting everything after it.
    const fa = flattenChildren(pa);
    const fb = flattenChildren(pb);
    const pairs = alignChildren(fa, fb);
    // If most siblings don't correspond, this region is a rewrite, not an edit —
    // overlaying it as one rectangle (height = max) is right; stacking one-sided
    // halves would double the height into a mess.
    const matched = pairs.filter(([x, y]) => x && y).length;
    if (matched < 0.5 * Math.max(fa.length, fb.length))
      return alignLeaf(pa, pb);
    const children = pairs.map(([ca, cb]) =>
      ca && cb
        ? matchAlign(ca, cb)
        : ca
          ? spanNode(ca, "a")
          : spanNode(cb!, "b"),
    );
    const x0 = pa.b.x0;
    const w = pa.b.x1 - pa.b.x0;
    if (pa.dir === "v") {
      const h = Math.max(...children.map((c) => c.h)); // columns: pad to tallest
      return { kind: "row", x0, w, h, children };
    }
    const h = children.reduce((s, c) => s + c.h, 0); // stacked: heights add up
    return { kind: "col", x0, w, h, children };
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
  kind: "added" | "removed" | "changed";
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Content-box diff for rectangle highlights, in AFTER-shot coordinates:
 *  - added   → a leaf present only in b (green),
 *  - changed → a matched leaf whose text/tag differs (amber),
 *  - removed → a leaf present only in a, y mapped to b-space (red).
 *
 * A flat classifier over the shared `alignMarkers` match — NOT the guillotine
 * partition (align and changed were entangled through it; decoupled so touching
 * the aligner can't regress highlights). `alignMarkers` already scores identity
 * (id / scope / class / grid-cell) on top of text, so a heavily-edited block
 * still MATCHES its old self → "changed", not add+remove; an inserted block is
 * unmatched → "added". "changed" is a CONTENT question (did the text/tag change?)
 * separate from "did they correspond?" — identity can make an edited element
 * score ~1, so compare the content key, not the match score. Semantic, so
 * anti-aliasing / cross-browser noise never lights up. [] without boxes.
 */
export const boxDiff = (
  a: Marker[],
  ah: number,
  b: Marker[],
  bh: number,
): DiffBox[] => {
  const leafy = (m: Marker): boolean => !isContainer(m) && !m.v && hasBox(m);
  const la = a.filter(leafy);
  const lb = b.filter(leafy);
  if (la.length === 0 && lb.length === 0) return [];

  // Change classification needs a trustworthy correspondence. Weak positional
  // pairings are add/remove, not an amber "changed" box.
  const { matches, onlyA, onlyB } = alignMarkers(la, lb, ANCHOR_MIN);
  const baseKey = (k: string): string => k.replace(/#\d+$/, "");
  const added: Marker[] = onlyB.map((i) => lb[i]);
  const removed: Marker[] = onlyA.map((i) => la[i]);
  const changed: Marker[] = [];
  for (const mm of matches) {
    if (baseKey(la[mm.ai].k) !== baseKey(lb[mm.bi].k)) changed.push(lb[mm.bi]);
  }

  const out: DiffBox[] = [];
  for (const m of added)
    if (hasBox(m))
      out.push({ kind: "added", x: m.x!, y: m.y, w: m.w!, h: m.h! });
  for (const m of changed)
    if (hasBox(m))
      out.push({ kind: "changed", x: m.x!, y: m.y, w: m.w!, h: m.h! });
  if (removed.length) {
    const bracketed = bracketAnchors(computeAnchors(a, b), ah, bh);
    for (const m of removed) {
      if (hasBox(m))
        out.push({
          kind: "removed",
          x: m.x!,
          y: mapPosition(m.y, bracketed),
          w: m.w!,
          h: m.h!,
        });
    }
  }
  return out;
};

// ── Spacing plan (DOM filler injection) ────────────────────────────────────

/** One spacer to inject before re-screenshotting. `px` is the gap height.
 *  `item` moves the column/card containing a marker as one box. */
export interface Spacer {
  i: number;
  px: number;
  mode:
    | "el"
    | "grid"
    | "tail"
    | "cell"
    | "row"
    | "scope"
    | "owner";
  sid?: string;
  owner?: string;
  action?: "before" | "inside" | "row";
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
export const spacingPlan = (
  a: Marker[],
  ah: number,
  b: Marker[],
  bh: number,
): SpacingPlan => {
  const pair = partitionPair(a, ah, b, bh);
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  if (!pair) return { a: A, b: B };

  const flowTarget = (markers: Marker[], i: number): number => {
    const marker = markers.find((candidate) => candidate.i === i);
    if (!marker?.sid) return i;
    const first = markers.find(
      (candidate) =>
        candidate.sid === marker.sid &&
        !isContainer(candidate) &&
        !candidate.v &&
        !candidate.na,
    );
    if (first?.i !== i) return i;
    return (
      markers.find(
        (candidate) =>
          isContainer(candidate) && candidate.id === marker.sid,
      )?.i ?? i
    );
  };
  const push = (
    list: Spacer[],
    i: number | undefined,
    px: number,
    mode: "el" | "grid" | "tail" | "cell",
  ): void => {
    if (i !== undefined && px > 0.5)
      list.push({
        i: mode === "el" ? flowTarget(list === A ? a : b, i) : i,
        px: Math.round(px),
        mode,
      });
  };
  const firstLeaf = (p: Part): Box | undefined =>
    leavesOf(p)
      .slice()
      .sort((x, y) => x.y0 - y.y0)[0];
  const heightOf = (p: Part): number => p.b.y1 - p.b.y0;

  // Returns leftover trailing pending [A,B] (the gap after the last anchor down
  // to the region bottom, e.g. content appended at the end) to carry forward.
  const leafRegion = (
    na: Part,
    nb: Part,
    pendA: number,
    pendB: number,
  ): [number, number] => {
    const ba = leavesOf(na)
      .slice()
      .sort((x, y) => x.y0 - y.y0);
    const bb = leavesOf(nb)
      .slice()
      .sort((x, y) => x.y0 - y.y0);
    if (ba[0]) push(A, ba[0].m.i, pendA, "el"); // flow push of this region
    if (bb[0]) push(B, bb[0].m.i, pendB, "el");
    const anchors = alignMarkers(
      ba.map((x) => x.m),
      bb.map((x) => x.m),
    ).matches.filter((m) => m.score >= ANCHOR_MIN);
    let pYA = na.b.y0;
    let pYB = nb.b.y0;
    for (const an of anchors) {
      const eA = ba[an.ai];
      const eB = bb[an.bi];
      const gapA = eA.y0 - pYA;
      const gapB = eB.y0 - pYB;
      const h = Math.max(gapA, gapB);
      push(A, eA.m.i, h - gapA, "el"); // inline gap before this anchor
      push(B, eB.m.i, h - gapB, "el");
      pYA = eA.y0;
      pYB = eB.y0;
    }
    const trailA = Math.max(0, na.b.y1 - pYA);
    const trailB = Math.max(0, nb.b.y1 - pYB);
    const h = Math.max(trailA, trailB);
    return [h - trailA, h - trailB];
  };

  // Stacked flow: pending threads through siblings. Returns leftover pending.
  const walk = (
    na: Part,
    nb: Part,
    pendA: number,
    pendB: number,
  ): [number, number] => {
    if (na.kind === "split" && nb.kind === "split" && na.dir === nb.dir) {
      const fa = flattenChildren(na);
      const fb = flattenChildren(nb);
      const pairs = alignChildren(fa, fb);
      const matched = pairs.filter(([x, y]) => x && y).length;
      if (matched < 0.5 * Math.max(fa.length, fb.length)) {
        return leafRegion(na, nb, pendA, pendB);
      }
      if (na.dir === "v") {
        // Columns / a grid row: push the whole grid down once, then each column
        // is its own vertical flow (fresh pending, no cross-column carry).
        const fla = firstLeaf(na);
        const flb = firstLeaf(nb);
        if (fla) push(A, fla.m.i, pendA, "grid");
        if (flb) push(B, flb.m.i, pendB, "grid");
        // Each matched column aligns internally (inline gaps between its anchors);
        // capture the leftover trailing deficit [ra, rb] — the pad each side needs
        // at the column BOTTOM to reach the column's aligned height `e` (the taller
        // side). matchAlign gives `e` (equalizes both sides, so headings that wrap
        // to different line counts are handled).
        const cols: Array<{
          ca: Part;
          cb: Part;
          e: number;
          ra: number;
          rb: number;
        }> = [];
        for (const [ca, cb] of pairs) {
          if (!(ca && cb)) continue;
          const [ra, rb] = walk(ca, cb, 0, 0);
          cols.push({ ca, cb, e: matchAlign(ca, cb).h, ra, rb });
        }
        // One-sided cards: an added/removed card reflows every later card into the
        // next/previous cell (row-major). Insert a filler CELL on the side missing
        // the card, before the next surviving card, so the cells stay put.
        for (let k = 0; k < pairs.length; k++) {
          const [ca, cb] = pairs[k];
          if (ca && cb) continue;
          const nextOn = (side: 0 | 1): Part | undefined => {
            for (let j = k + 1; j < pairs.length; j++)
              if (pairs[j][side]) return pairs[j][side]!;
            return undefined;
          };
          if (ca && !cb) {
            const anchor = firstLeaf(nextOn(1) ?? ca);
            if (nextOn(1)) push(B, anchor?.m.i, heightOf(ca), "cell");
          } else if (cb && !ca) {
            const anchor = firstLeaf(nextOn(0) ?? cb);
            if (nextOn(0)) push(A, anchor?.m.i, heightOf(cb), "cell");
          }
        }
        // Equalize the row height so the row bottom — and everything below it —
        // lines up. With align-items: stretch the row is its tallest column, so
        // grow EACH column's shorter side up to the tallest column's height. Per
        // column: pad its own bottom (ra/rb → reach `e`) plus (rowH − e) to reach
        // the row. Growing just one card fails when it isn't the tallest — the row
        // stays defined by another card and never grows (the "silicon shift" bug).
        const rowH = cols.reduce((mx, c) => Math.max(mx, c.e), 0);
        for (const c of cols) {
          push(A, firstLeaf(c.ca)?.m.i, c.ra + (rowH - c.e), "tail");
          push(B, firstLeaf(c.cb)?.m.i, c.rb + (rowH - c.e), "tail");
        }
        return [0, 0];
      }
      // Stacked column of blocks.
      let pA = pendA;
      let pB = pendB;
      for (const [ca, cb] of pairs) {
        if (ca && cb) [pA, pB] = walk(ca, cb, pA, pB);
        else if (ca)
          pB += heightOf(ca); // removed block → gap on B
        else pA += heightOf(cb!); // added block → gap on A
      }
      return [pA, pB];
    }
    return leafRegion(na, nb, pendA, pendB);
  };

  walk(pair.pa, pair.pb, 0, 0);
  return { a: A, b: B };
};

// ── Alignment verification (self-improving harness) ────────────────────────

export interface AlignReport {
  /** Aligned total height on each side (natural + injected fillers). */
  alignedA: number;
  alignedB: number;
  /** |alignedA − alignedB| — should be ~0; large means a gap wasn't filled. */
  heightGap: number;
  /** Worst matched-pair y misalignment after applying the plan (px). */
  maxPairDelta: number;
  /** Matched pairs that still land > 2px apart: [markerA.i, markerB.i, dy]. */
  misaligned: Array<{ ia?: number; ib?: number; dy: number }>;
}

/**
 * Check the spacing plan actually aligns the two shots — used to iterate on the
 * aligner (scaffold a failing case, tighten until heightGap and maxPairDelta go
 * to ~0). Applies the plan to the marker y's (a simple top-to-bottom flow
 * simulation) and compares matched pairs, plus the total heights. Absolute
 * (x is unchanged by fillers; y is what the fillers move).
 */
export const verifyAlignment = (
  a: Marker[],
  ah: number,
  b: Marker[],
  bh: number,
): AlignReport => {
  const plan = spacingPlan(a, ah, b, bh);
  const sum = (s: Spacer[]): number => s.reduce((t, x) => t + x.px, 0);
  const alignedA = ah + sum(plan.a);
  const alignedB = bh + sum(plan.b);

  // Flow simulation: a spacer before element i shifts i and everything below.
  const applied = (m: Marker[], spacers: Spacer[]): Map<number, number> => {
    const byI = new Map<number, number>();
    for (const s of spacers) byI.set(s.i, (byI.get(s.i) ?? 0) + s.px);
    const leaves = m
      .filter((x) => x.i !== undefined && x.k.charCodeAt(0) !== 35)
      .slice()
      .sort((p, q) => p.y - q.y);
    let cum = 0;
    const out = new Map<number, number>();
    for (const x of leaves) {
      cum += byI.get(x.i!) ?? 0;
      out.set(x.i!, x.y + cum);
    }
    return out;
  };
  const yA = applied(a, plan.a);
  const yB = applied(b, plan.b);

  const la = a.filter((m) => m.k.charCodeAt(0) !== 35);
  const lb = b.filter((m) => m.k.charCodeAt(0) !== 35);
  const { matches } = alignMarkers(la, lb);
  const misaligned: AlignReport["misaligned"] = [];
  let maxPairDelta = 0;
  for (const mm of matches) {
    if (mm.score < ANCHOR_MIN) continue;
    const ia = la[mm.ai].i;
    const ib = lb[mm.bi].i;
    if (ia === undefined || ib === undefined) continue;
    const dy = (yA.get(ia) ?? 0) - (yB.get(ib) ?? 0);
    if (Math.abs(dy) > Math.abs(maxPairDelta)) maxPairDelta = dy;
    if (Math.abs(dy) > 2) misaligned.push({ ia, ib, dy: Math.round(dy) });
  }
  return {
    alignedA,
    alignedB,
    heightGap: Math.abs(alignedA - alignedB),
    maxPairDelta: Math.round(maxPairDelta),
    misaligned,
  };
};

/**
 * Residual misalignment between two ALREADY-reflowed shots (re-collected after
 * spacer injection): matched elements should now share a y. Used server-side to
 * log real absolute-y drift so the aligner can be improved. `max` is the worst
 * signed dy; `worst` lists the largest offenders.
 */
export const matchedYDelta = (
  a: Marker[],
  b: Marker[],
  trustedOnly = false,
): { max: number; worst: Array<{ ia?: number; ib?: number; dy: number }> } => {
  const la = a.filter((m) => !isContainer(m) && !m.na);
  const lb = b.filter((m) => !isContainer(m) && !m.na);
  const { matches } = alignMarkers(la, lb);
  const base = (k: string): string => k.replace(/#\d+$/, "");
  const counts = (ms: Marker[], field: "k" | "id"): Map<string, number> => {
    const result = new Map<string, number>();
    for (const m of ms) {
      const value = field === "k" ? base(m.k) : m.id;
      if (value) result.set(value, (result.get(value) ?? 0) + 1);
    }
    return result;
  };
  const keysA = counts(la, "k");
  const keysB = counts(lb, "k");
  const idsA = counts(la, "id");
  const idsB = counts(lb, "id");
  const trusted = (ea: Marker, eb: Marker): boolean => {
    const sameId =
      !!ea.id &&
      ea.id === eb.id &&
      idsA.get(ea.id) === 1 &&
      idsB.get(ea.id) === 1;
    const key = base(ea.k);
    const sameUniqueKey =
      key === base(eb.k) && keysA.get(key) === 1 && keysB.get(key) === 1;
    return sameId || sameUniqueKey;
  };
  let max = 0;
  const worst: Array<{ ia?: number; ib?: number; dy: number }> = [];
  for (const mm of matches) {
    if (mm.score < ANCHOR_MIN) continue;
    if (la[mm.ai].v || lb[mm.bi].v) {
      const left = la[mm.ai];
      const right = lb[mm.bi];
      if (
        !left.v ||
        !right.v ||
        keysA.get(base(left.k)) !== 1 ||
        keysB.get(base(right.k)) !== 1
      )
        continue;
    }
    if (trustedOnly && !trusted(la[mm.ai], lb[mm.bi])) continue;
    const dy = la[mm.ai].y - lb[mm.bi].y;
    if (Math.abs(dy) > Math.abs(max)) max = dy;
    if (Math.abs(dy) > 8)
      worst.push({ ia: la[mm.ai].i, ib: lb[mm.bi].i, dy: Math.round(dy) });
  }
  worst.sort((p, q) => Math.abs(q.dy) - Math.abs(p.dy));
  return { max, worst: worst.slice(0, 8) };
};

type ResidualPair = { ea: Marker; eb: Marker; dy: number };
const CSS_PX = 1 / 64;
const cssPx = (value: number): number => Math.round(value / CSS_PX) * CSS_PX;

const strongLeafPairs = (a: Marker[], b: Marker[]): ResidualPair[] => {
  const fa = a.filter((m) => !isContainer(m) && !m.na);
  const fb = b.filter((m) => !isContainer(m) && !m.na);
  const base = (m: Marker): string => m.k.replace(/#\d+$/, "");
  const visualCounts = (markers: Marker[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const marker of markers)
      if (marker.v)
        counts.set(base(marker), (counts.get(base(marker)) ?? 0) + 1);
    return counts;
  };
  const va = visualCounts(fa);
  const vb = visualCounts(fb);
  return alignMarkers(fa, fb)
    .matches.filter((m) => {
      if (m.score < ANCHOR_MIN) return false;
      const left = fa[m.ai];
      const right = fb[m.bi];
      if (!left.v && !right.v) return true;
      return (
        left.v === true &&
        right.v === true &&
        va.get(base(left)) === 1 &&
        vb.get(base(right)) === 1
      );
    })
    .map((m) => ({
      ea: fa[m.ai],
      eb: fb[m.bi],
      dy: fa[m.ai].y - fb[m.bi].y,
    }));
};

const reportPairs = (
  pairs: ResidualPair[],
): { max: number; worst: Array<{ ia?: number; ib?: number; dy: number }> } => {
  const worst = pairs
    .filter((p) => Math.abs(p.dy) > 8)
    .map((p) => ({ ia: p.ea.i, ib: p.eb.i, dy: Math.round(p.dy) }))
    .sort((p, q) => Math.abs(q.dy) - Math.abs(p.dy));
  const max = pairs.reduce(
    (found, p) => (Math.abs(p.dy) > Math.abs(found) ? p.dy : found),
    0,
  );
  return { max, worst: worst.slice(0, 8) };
};

const landmarkPairs = (a: Marker[], b: Marker[]): ResidualPair[] => {
  const landmark = (m: Marker) =>
    isContainer(m) &&
    (m.d ?? Number.POSITIVE_INFINITY) <= 1 &&
    /^#(?:SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV)\//.test(m.k);
  const fa = a.filter(landmark);
  const fb = b.filter(landmark);
  return alignMarkers(fa, fb)
    .matches.filter((m) => m.score >= ANCHOR_MIN)
    .map((m) => ({
      ea: fa[m.ai],
      eb: fb[m.bi],
      dy: fa[m.ai].y - fb[m.bi].y,
    }))
    .sort((p, q) => p.ea.y - q.ea.y);
};

/** Align top-level semantic landmarks as one ordinary vertical flow. */
export const correctiveLandmarks = (
  a: Marker[],
  b: Marker[],
): SpacingPlan => {
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  let cumA = 0;
  let cumB = 0;
  for (const { ea, eb } of landmarkPairs(a, b)) {
    const d = ea.y + cumA - (eb.y + cumB);
    if (d > CSS_PX && eb.i !== undefined) {
      B.push({ i: eb.i, px: cssPx(d), mode: "el" });
      cumB += d;
    } else if (d < -CSS_PX && ea.i !== undefined) {
      A.push({ i: ea.i, px: cssPx(-d), mode: "el" });
      cumA -= d;
    }
  }
  return { a: A, b: B };
};

export const landmarkYDelta = (a: Marker[], b: Marker[]) =>
  reportPairs(landmarkPairs(a, b));

const scopeLeadPairs = (a: Marker[], b: Marker[]): ResidualPair[] => {
  const scoped = new Map<string, ResidualPair[]>();
  for (const pair of strongLeafPairs(a, b)) {
    if (
      !pair.ea.sid ||
      pair.ea.sid !== pair.eb.sid ||
      pair.ea.sy === undefined ||
      pair.eb.sy === undefined
    )
      continue;
    const list = scoped.get(pair.ea.sid) ?? [];
    list.push({
      ...pair,
      dy: pair.ea.y - pair.ea.sy - (pair.eb.y - pair.eb.sy),
    });
    scoped.set(pair.ea.sid, list);
  }
  return [...scoped.values()]
    // A lone rewritten element is only a structural guess. Require another
    // corresponding descendant before moving an entire scoped section.
    .filter((pairs) => pairs.length > 1)
    .map((pairs) => pairs.sort((x, y) => x.ea.y - y.ea.y)[0])
    .sort((x, y) => x.ea.y - y.ea.y);
};

/** Align the first visible content inside each corresponding scoped section. */
export const correctiveScopeLeads = (a: Marker[], b: Marker[]): SpacingPlan => {
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  for (const { ea, eb, dy: d } of scopeLeadPairs(a, b)) {
    if (d > CSS_PX && eb.i !== undefined) {
      B.push({ i: eb.i, px: cssPx(d), mode: "scope", sid: eb.sid });
    } else if (d < -CSS_PX && ea.i !== undefined) {
      A.push({ i: ea.i, px: cssPx(-d), mode: "scope", sid: ea.sid });
    }
  }
  return { a: A, b: B };
};

export const scopeLeadYDelta = (a: Marker[], b: Marker[]) =>
  reportPairs(scopeLeadPairs(a, b));

interface ResidualGroup {
  key: string;
  orderA: number;
  orderB: number;
  pairs: ResidualPair[];
}

const median = (values: number[]): number => {
  const sorted = values.slice().sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const scopeBaselines = (pairs: ResidualPair[]): Map<string, number> => {
  const byScope = new Map<string, ResidualPair[]>();
  for (const pair of pairs) {
    if (!pair.ea.sid || pair.ea.sid !== pair.eb.sid) continue;
    const list = byScope.get(pair.ea.sid) ?? [];
    list.push(pair);
    byScope.set(pair.ea.sid, list);
  }
  const result = new Map<string, number>();
  for (const [scope, scoped] of byScope) {
    scoped.sort((x, y) => x.ea.y - y.ea.y || x.eb.y - y.eb.y);
    const first = scoped[0];
    const firstRow = scoped.filter(
      (pair) =>
        Math.abs(pair.ea.y - first.ea.y) <= 2 &&
        Math.abs(pair.eb.y - first.eb.y) <= 2,
    );
    result.set(scope, median(firstRow.map((pair) => pair.dy)));
  }
  return result;
};

const rowGroups = (a: Marker[], b: Marker[]): ResidualGroup[] => {
  const groups = new Map<string, ResidualGroup>();
  const pairs = strongLeafPairs(a, b);
  const baselines = scopeBaselines(pairs);
  for (const pair of pairs) {
    const { ea, eb } = pair;
    if (
      !ea.rg ||
      !eb.rg ||
      // Icon/text internals of a list item are horizontal presentation, not a
      // page-flow row. Treating every LI as its own row grows every list item
      // and accumulates large downstream drift; the outer column item-flow
      // pass aligns the LI blocks instead.
      ea.rg.startsWith("LI/") ||
      eb.rg.startsWith("LI/") ||
      ea.rp === undefined ||
      eb.rp === undefined ||
      ea.ry === undefined ||
      eb.ry === undefined ||
      ea.rg.split("@")[0] !== eb.rg.split("@")[0]
    )
      continue;
    const baseline = ea.sid && ea.sid === eb.sid ? baselines.get(ea.sid) : undefined;
    if (baseline === undefined) continue;
    const parent = `${ea.sid ?? ""}|${ea.rg}|${ea.rp}|${eb.sid ?? ""}|${eb.rg}|${eb.rp}`;
    const key = `${parent}|${ea.ry}|${eb.ry}`;
    const group = groups.get(key) ?? {
      key: parent,
      orderA: ea.ry,
      orderB: eb.ry,
      pairs: [],
    };
    // Measure visible descendants, not the row item's border box. Grid margins
    // and padding can move content while getBoundingClientRect().top on the
    // item remains unchanged, which otherwise reports false convergence.
    group.pairs.push({
      ...pair,
      dy: pair.dy - baseline,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
};

/**
 * Align complete grid/flex rows. All matched descendants of one visual row
 * collapse to one consensus correction, and the browser moves every item in
 * that row together. Cumulative carry is isolated per row container.
 */
export const correctiveRows = (
  a: Marker[],
  b: Marker[],
  gain = 0.7,
): SpacingPlan => {
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  const byParent = new Map<string, ResidualGroup[]>();
  for (const row of rowGroups(a, b)) {
    const list = byParent.get(row.key) ?? [];
    list.push(row);
    byParent.set(row.key, list);
  }
  for (const rows of byParent.values()) {
    rows.sort((x, y) => x.orderA - y.orderA || x.orderB - y.orderB);
    let cumA = 0;
    let cumB = 0;
    for (const row of rows) {
      const d = median(row.pairs.map((p) => p.dy)) + cumA - cumB;
      const px = cssPx(Math.abs(d) * gain);
      if (px < CSS_PX) continue;
      const marker = d > 0 ? row.pairs[0].eb : row.pairs[0].ea;
      if (marker.i === undefined) continue;
      (d > 0 ? B : A).push({ i: marker.i, px, mode: "row" });
      if (d > 0) cumB += px;
      else cumA += px;
    }
  }
  return { a: A, b: B };
};

export const rowYDelta = (a: Marker[], b: Marker[]) =>
  reportPairs(
    rowGroups(a, b).map((row) => {
      const pair = row.pairs[0];
      return { ...pair, dy: median(row.pairs.map((p) => p.dy)) };
    }),
  );

const itemFlowGroups = (a: Marker[], b: Marker[]): ResidualGroup[] => {
  const groups = new Map<string, ResidualGroup>();
  const pairs = strongLeafPairs(a, b);
  const baselines = scopeBaselines(pairs);
  for (const pair of pairs) {
    const { ea, eb } = pair;
    if (
      !ea.rg ||
      !eb.rg ||
      ea.rp === undefined ||
      eb.rp === undefined ||
      ea.rc === undefined ||
      eb.rc === undefined ||
      ea.rg.split("@")[0] !== eb.rg.split("@")[0]
    )
      continue;
    const baseline = ea.sid && ea.sid === eb.sid ? baselines.get(ea.sid) : undefined;
    if (baseline === undefined) continue;
    const key = `${ea.sid ?? ""}|${ea.rg}|${ea.rp}|${ea.rc}|${eb.sid ?? ""}|${eb.rg}|${eb.rp}|${eb.rc}`;
    const group = groups.get(key) ?? {
      key,
      orderA: ea.y,
      orderB: eb.y,
      pairs: [],
    };
    group.pairs.push({
      ...pair,
      dy: pair.dy - baseline,
    });
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.pairs.length > 1);
};

/** Align content flow inside corresponding grid/flex items after row tops fit. */
export const correctiveItemFlows = (
  a: Marker[],
  b: Marker[],
  gain = 0.7,
): SpacingPlan => {
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  for (const group of itemFlowGroups(a, b)) {
    const pairs = group.pairs.slice().sort((x, y) => x.ea.y - y.ea.y);
    let cumA = 0;
    let cumB = 0;
    // The row stage owns the shared row shift; this section-relative residual
    // is what remains per item, including a first leaf hidden by row consensus.
    for (const { ea, eb, dy } of pairs) {
      const d = dy + cumA - cumB;
      const px = cssPx(Math.abs(d) * gain);
      if (px < CSS_PX) continue;
      const marker = d > 0 ? eb : ea;
      if (marker.i === undefined) continue;
      (d > 0 ? B : A).push({ i: marker.i, px, mode: "el" });
      if (d > 0) cumB += px;
      else cumA += px;
    }
  }
  return { a: A, b: B };
};

export const itemFlowYDelta = (a: Marker[], b: Marker[]) =>
  reportPairs(itemFlowGroups(a, b).flatMap((g) => g.pairs));

const sectionFlowGroups = (a: Marker[], b: Marker[]): ResidualGroup[] => {
  const groups = new Map<string, ResidualGroup>();
  for (const pair of strongLeafPairs(a, b)) {
    const { ea, eb } = pair;
    if (!ea.sid || ea.sid !== eb.sid || ea.rg || eb.rg) continue;
    const group = groups.get(ea.sid) ?? {
      key: ea.sid,
      orderA: ea.y,
      orderB: eb.y,
      pairs: [],
    };
    group.pairs.push(pair);
    groups.set(ea.sid, group);
  }
  return [...groups.values()]
    .filter((group) => group.pairs.length > 1)
    .map((group) => {
      const pairs = group.pairs.slice().sort((x, y) => x.ea.y - y.ea.y);
      const baseline = pairs[0].dy;
      return {
        ...group,
        pairs: pairs.map((pair) => ({ ...pair, dy: pair.dy - baseline })),
      };
    });
};

/** Align ordinary vertical content that sits between/after row layouts. */
export const correctiveSectionFlows = (
  a: Marker[],
  b: Marker[],
  gain = 0.7,
): SpacingPlan => {
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  for (const group of sectionFlowGroups(a, b)) {
    const pairs = group.pairs.slice().sort((x, y) => x.ea.y - y.ea.y);
    let cumA = 0;
    let cumB = 0;
    for (const { ea, eb, dy } of pairs) {
      const d = dy + cumA - cumB;
      const px = cssPx(Math.abs(d) * gain);
      if (px < CSS_PX) continue;
      const marker = d > 0 ? eb : ea;
      if (marker.i === undefined) continue;
      (d > 0 ? B : A).push({ i: marker.i, px, mode: "el" });
      if (d > 0) cumB += px;
      else cumA += px;
    }
  }
  return { a: A, b: B };
};

export const sectionFlowYDelta = (a: Marker[], b: Marker[]) =>
  reportPairs(sectionFlowGroups(a, b).flatMap((group) => group.pairs));

const footerFlowGroups = (a: Marker[], b: Marker[]): ResidualGroup[] => {
  const groups = new Map<string, ResidualGroup>();
  for (const pair of strongLeafPairs(a, b)) {
    const { ea, eb } = pair;
    if (
      !ea.s?.startsWith("FOOTER/") ||
      !eb.s?.startsWith("FOOTER/") ||
      !ea.rg ||
      !eb.rg ||
      ea.rc === undefined ||
      eb.rc === undefined ||
      ea.rg.split("@")[0] !== eb.rg.split("@")[0]
    )
      continue;
    const key = `${ea.rg}|${ea.rc}|${eb.rg}|${eb.rc}`;
    const group = groups.get(key) ?? {
      key,
      orderA: ea.y,
      orderB: eb.y,
      pairs: [],
    };
    group.pairs.push(pair);
    groups.set(key, group);
  }
  return [...groups.values()];
};

/** Align terminal footer columns independently; they have no downstream flow. */
export const correctiveFooterFlows = (
  a: Marker[],
  b: Marker[],
  gain = 0.7,
): SpacingPlan => {
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  for (const group of footerFlowGroups(a, b)) {
    const pairs = group.pairs.slice().sort((x, y) => x.ea.y - y.ea.y);
    let cumA = 0;
    let cumB = 0;
    for (const { ea, eb, dy } of pairs) {
      const d = dy + cumA - cumB;
      const px = cssPx(Math.abs(d) * gain);
      if (px < CSS_PX) continue;
      const marker = d > 0 ? eb : ea;
      if (marker.i === undefined) continue;
      (d > 0 ? B : A).push({ i: marker.i, px, mode: "el" });
      if (d > 0) cumB += px;
      else cumA += px;
    }
  }
  return { a: A, b: B };
};

export const footerFlowYDelta = (a: Marker[], b: Marker[]) =>
  reportPairs(footerFlowGroups(a, b).flatMap((group) => group.pairs));

/**
 * LAST-RESORT corrective, computed from the ALREADY-reflowed markers (after the
 * structural spacing plan was injected and re-collected). Whatever residual drift
 * the structural aligner couldn't remove, this measures and patches — no layout
 * model at all: walk matched pairs top-to-bottom and pad each element still too
 * high by its OWN residual (a `margin-top` flow filler keyed by the re-collected
 * id), then re-collect and repeat. Because it only ever moves measured content to
 * where its match sits, it is layout-agnostic — grids, flex, tables, nesting all
 * converge the same way, including cases the structural pass leaves off (a grid
 * row whose cells drifted by different amounts).
 *
 * The browser probe resolves each target to a real owner and measures its effects
 * on every other requested target. The graph solver accounts for those measured
 * dependencies; this generator therefore emits independent residuals rather than
 * guessing which margins cascade. `gain` (< 1) still undershoots each round so an
 * additive correction approaches its target safely.
 */
export const correctiveFlat = (
  a: Marker[],
  b: Marker[],
  gain = 0.7,
): SpacingPlan => {
  const pairs = strongLeafPairs(a, b).sort((p, q) => p.ea.y - q.ea.y);
  const A: Spacer[] = [];
  const B: Spacer[] = [];
  for (const { ea, eb } of pairs) {
    const d = ea.y - eb.y;
    if (d > CSS_PX && eb.i !== undefined) {
      const px = d * gain;
      B.push({ i: eb.i, px: cssPx(px), mode: "el" });
    } else if (d < -CSS_PX && ea.i !== undefined) {
      const px = -d * gain;
      A.push({ i: ea.i, px: cssPx(px), mode: "el" });
    }
  }
  return { a: A, b: B };
};
