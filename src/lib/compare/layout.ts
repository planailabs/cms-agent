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
  | { kind: 'split'; dir: 'h' | 'v'; children: [Part, Part]; b: Bounds };

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

const boxOf = (m: Marker): Box | null => {
  if (m.x === undefined || m.w === undefined || m.h === undefined) return null;
  return { x0: m.x, y0: m.y, x1: m.x + m.w, y1: m.y + m.h, m };
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
  const pick = v && (!h || v.gap >= h.gap) ? { dir: 'v' as const, pos: v.pos } : h ? { dir: 'h' as const, pos: h.pos } : null;
  if (!pick) return { kind: 'leaf', boxes, b };

  const isV = pick.dir === 'v';
  const key = (bx: Box) => (isV ? bx.x1 : bx.y1);
  const first: Box[] = [];
  const second: Box[] = [];
  for (const bx of boxes) (key(bx) <= pick.pos ? first : second).push(bx);
  if (first.length === 0 || second.length === 0) return { kind: 'leaf', boxes, b };

  const b1: Bounds = isV ? { ...b, x1: pick.pos } : { ...b, y1: pick.pos };
  const b2: Bounds = isV ? { ...b, x0: pick.pos } : { ...b, y0: pick.pos };
  return { kind: 'split', dir: pick.dir, children: [partition(first, b1), partition(second, b2)], b };
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

/** Match two partition trees into an aligned render tree. */
const matchAlign = (pa: Part, pb: Part): ANode => {
  if (
    pa.kind === 'split' &&
    pb.kind === 'split' &&
    pa.dir === pb.dir &&
    pa.children.length === pb.children.length
  ) {
    const children = pa.children.map((c, i) => matchAlign(c, pb.children[i]));
    const x0 = pa.b.x0;
    const w = pa.b.x1 - pa.b.x0;
    if (pa.dir === 'v') {
      // side-by-side: pad each column to the tallest
      const h = Math.max(...children.map((c) => c.h));
      return { kind: 'row', x0, w, h, children };
    }
    // stacked: heights add up
    const h = children.reduce((s, c) => s + c.h, 0);
    return { kind: 'col', x0, w, h, children };
  }
  // shape mismatch (or both leaves) → align as one 1-D rectangle
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
  const boxesA = a.filter((m) => m.k.charCodeAt(0) !== 35).map(boxOf).filter((x): x is Box => x !== null);
  const boxesB = b.filter((m) => m.k.charCodeAt(0) !== 35).map(boxOf).filter((x): x is Box => x !== null);
  if (boxesA.length === 0 || boxesB.length === 0) return null;
  const w = Math.max(...boxesA.map((x) => x.x1), ...boxesB.map((x) => x.x1));
  const pa = partition(boxesA, { x0: 0, y0: 0, x1: w, y1: ah });
  const pb = partition(boxesB, { x0: 0, y0: 0, x1: w, y1: bh });
  return matchAlign(pa, pb);
};

// ── Box-diff highlights ────────────────────────────────────────────────────

export interface DiffBox {
  kind: 'added' | 'removed' | 'changed';
  x: number;
  y: number;
  w: number;
  h: number;
}

const isContainer = (m: Marker): boolean => m.k.charCodeAt(0) === 35;
const hasBox = (m: Marker): boolean => m.x !== undefined && m.w !== undefined && m.h !== undefined;

/**
 * Content-box diff for rectangle highlights, in AFTER-shot coordinates:
 *  - added   → a leaf present only in b (green),
 *  - changed → a matched leaf whose text/size differs (amber),
 *  - removed → a leaf present only in a, its y mapped into b-space (red).
 * Semantic, so anti-aliasing / font-rendering / cross-browser noise never
 * lights up — unlike a pixel diff. Returns [] without bounding boxes.
 */
export const boxDiff = (a: Marker[], ah: number, b: Marker[], bh: number): DiffBox[] => {
  const { matches, onlyA, onlyB } = alignMarkers(a, b);
  const out: DiffBox[] = [];
  for (const i of onlyB) {
    const m = b[i];
    if (!isContainer(m) && hasBox(m)) out.push({ kind: 'added', x: m.x!, y: m.y, w: m.w!, h: m.h! });
  }
  for (const mm of matches) {
    const m = b[mm.bi];
    if (mm.score < 0.999 && !isContainer(m) && hasBox(m)) {
      out.push({ kind: 'changed', x: m.x!, y: m.y, w: m.w!, h: m.h! });
    }
  }
  if (onlyA.some((i) => !isContainer(a[i]) && hasBox(a[i]))) {
    const bracketed = bracketAnchors(computeAnchors(a, b), ah, bh);
    for (const i of onlyA) {
      const m = a[i];
      if (!isContainer(m) && hasBox(m)) {
        out.push({ kind: 'removed', x: m.x!, y: mapPosition(m.y, bracketed), w: m.w!, h: m.h! });
      }
    }
  }
  return out;
};
