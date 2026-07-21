/**
 * Recursive both-pages aligner. Instead of slicing each shot geometrically and
 * matching the two rectangle trees afterwards, this walks the two DOM trees IN
 * LOCKSTEP: at every node it evaluates (child heights), compares (matches the
 * two children lists by content identity), and aligns (emits fillers so matched
 * content shares a y). Layout mode is ground truth — a grid is a grid, not a
 * guess from gaps — so a grid whose column gap is wider than its row gap is
 * still handled row-major.
 *
 * The collector only keeps SEMANTIC elements, so a div-based grid's container and
 * cells aren't tree nodes. Their leaves carry `fx` (the flex/grid cell they live
 * in), so `regroup` rebuilds the grid → cell → leaves structure from `fx` before
 * aligning. Output is the same filler modes the injector understands (`el`,
 * `tail`, `cell`, `push`), so it drops into the existing inject pipeline.
 *
 * alignPair(a, b): a and b are a matched pair whose TOPS the caller has already
 * aligned; it emits the fillers that align their descendants and returns
 * [addedA, addedB] — the filler added inside each side — so the caller keeps the
 * following siblings aligned.
 */
import { alignMarkers, type Marker } from "./markers";
import type { Spacer, SpacingPlan } from "./layout";

interface TNode {
  m: Marker;
  kids: TNode[];
  cell?: boolean; // synthetic grid CELL (a card); push/grow target its grid item
  grid?: boolean; // synthetic grid container (kids are cells)
}

const fxCont = (fx?: string): string | null =>
  fx === undefined
    ? null
    : fx.indexOf("#") >= 0
      ? fx.slice(0, fx.indexOf("#"))
      : fx;
const fxCell = (fx?: string): string =>
  fx && fx.indexOf("#") >= 0 ? fx.slice(fx.indexOf("#") + 1) : "0";
const X = (n: TNode): number => n.m.x ?? 0;
const H = (n: TNode): number => n.m.h ?? 0;
const top = (n: TNode): number => n.m.y;

const bbox = (ns: TNode[]): { y: number; x: number; w: number; h: number } => {
  const y = Math.min(...ns.map(top));
  const x = Math.min(...ns.map(X));
  const r = Math.max(...ns.map((n) => X(n) + (n.m.w ?? 0)));
  const b = Math.max(...ns.map((n) => top(n) + H(n)));
  return { y, x, w: r - x, h: b - y };
};

/** Rebuild the pruned DOM forest from the flat markers via `pi` (parent index),
 *  then regroup fx-tagged runs into synthetic grid → cell nodes. */
export const buildForest = (markers: Marker[]): TNode[] => {
  const byI = new Map<number, TNode>();
  for (const m of markers) if (m.i !== undefined) byI.set(m.i, { m, kids: [] });
  const roots: TNode[] = [];
  for (const m of markers) {
    if (m.i === undefined) continue;
    const node = byI.get(m.i)!;
    const p = m.pi !== undefined && m.pi >= 0 ? byI.get(m.pi) : undefined;
    if (p) p.kids.push(node);
    else roots.push(node);
  }
  const sortRec = (n: TNode): void => {
    n.kids.sort((a, b) => top(a) - top(b) || X(a) - X(b));
    n.kids.forEach(sortRec);
  };
  roots.sort((a, b) => top(a) - top(b));
  roots.forEach(sortRec);
  roots.forEach(regroup);
  return roots;
};

/** Replace each run of siblings sharing an fx grid container with a synthetic
 *  grid node whose cells group the leaves by cell index. */
const regroup = (n: TNode): void => {
  n.kids.forEach(regroup);
  const k = n.kids;
  const out: TNode[] = [];
  let i = 0;
  while (i < k.length) {
    const cont = fxCont(k[i].m.fx);
    if (cont !== null) {
      let j = i;
      const mem: TNode[] = [];
      while (j < k.length && fxCont(k[j].m.fx) === cont) mem.push(k[j++]);
      const byCell = new Map<string, TNode[]>();
      for (const m of mem) {
        const ci = fxCell(m.m.fx);
        (byCell.get(ci) ?? byCell.set(ci, []).get(ci)!).push(m);
      }
      if (byCell.size >= 2) {
        const cells: TNode[] = [];
        for (const leaves of byCell.values()) {
          leaves.sort((a, b) => top(a) - top(b));
          cells.push({
            m: { k: "#cell", d: "s", ...bbox(leaves) } as Marker,
            kids: leaves,
            cell: true,
          });
        }
        cells.sort((a, b) => top(a) - top(b) || X(a) - X(b));
        out.push({
          m: { k: "#grid", d: "g", ...bbox(cells) } as Marker,
          kids: cells,
          grid: true,
        });
        i = j;
        continue;
      }
    }
    out.push(k[i++]);
  }
  n.kids = out;
};

type Plan = { a: Spacer[]; b: Spacer[] };
const firstLeaf = (n: TNode): TNode =>
  n.kids.length ? firstLeaf(n.kids[0]) : n;
const emit = (
  list: Spacer[],
  i: number | undefined,
  px: number,
  mode: Spacer["mode"],
): void => {
  if (px > 0.5 && i !== undefined) list.push({ i, px: Math.round(px), mode });
};
const firstRow = (cells: TNode[]): TNode[] => {
  if (!cells.length) return [];
  const y0 = Math.min(...cells.map(top));
  return cells.filter((c) => top(c) - y0 <= 8);
};
/** Push a node down by px (aligning its top): a grid pushes its first row's
 *  cells (grid flow carries the rest), a cell pushes its own grid item, a plain
 *  block/leaf takes a flow filler / margin-top before it. */
const pushNode = (list: Spacer[], n: TNode, px: number): void => {
  if (px <= 0.5) return;
  if (n.grid)
    for (const c of firstRow(n.kids)) emit(list, firstLeaf(c).m.i, px, "push");
  else if (n.cell) emit(list, firstLeaf(n).m.i, px, "push");
  else emit(list, n.m.i, px, "el");
};
/** Grow a node's height by px at its bottom (a cell grows its grid item). */
const growNode = (list: Spacer[], n: TNode, px: number): void => {
  if (px <= 0.5) return;
  emit(list, n.cell ? firstLeaf(n).m.i : n.m.i, px, "tail");
};

/** Ordered matched / one-sided child pairs (document order preserved). */
const pairChildren = (
  a: TNode[],
  b: TNode[],
): Array<[TNode | null, TNode | null]> => {
  const { matches } = alignMarkers(
    a.map((k) => k.m),
    b.map((k) => k.m),
  );
  const byA = new Map<number, number>();
  for (const mm of matches) if (mm.score >= 0.3) byA.set(mm.ai, mm.bi);
  const usedB = new Set(byA.values());
  const out: Array<[TNode | null, TNode | null]> = [];
  let bi = 0;
  for (let ai = 0; ai < a.length; ai++) {
    const j = byA.get(ai);
    if (j === undefined) {
      out.push([a[ai], null]);
      continue;
    }
    while (bi < j) {
      if (!usedB.has(bi)) out.push([null, b[bi]]);
      bi++;
    }
    out.push([a[ai], b[j]]);
    bi = j + 1;
  }
  while (bi < b.length) {
    if (!usedB.has(bi)) out.push([null, b[bi]]);
    bi++;
  }
  return out;
};

const arrange = (a: TNode, b: TNode): "g" | "r" | "s" => {
  if (a.grid || b.grid || a.m.d === "g" || b.m.d === "g") return "g";
  if (a.m.d === "r" || b.m.d === "r") return "r";
  return "s";
};

const rowsOf = (kids: TNode[]): TNode[][] => {
  const rows: TNode[][] = [];
  let cur: TNode[] = [];
  let t = -Infinity;
  for (const k of [...kids].sort((p, q) => top(p) - top(q) || X(p) - X(q))) {
    if (cur.length && top(k) - t > 8) {
      rows.push(cur);
      cur = [];
    }
    if (!cur.length) t = top(k);
    cur.push(k);
  }
  if (cur.length) rows.push(cur);
  return rows;
};
const rowTop = (r: TNode[]): number => Math.min(...r.map(top));
const rowBot = (r: TNode[]): number => Math.max(...r.map((c) => top(c) + H(c)));

export const alignForest = (ma: Marker[], mb: Marker[]): SpacingPlan => {
  const P: Plan = { a: [], b: [] };
  const rootA: TNode = {
    m: { k: "#root", y: 0, d: "s" } as Marker,
    kids: buildForest(ma),
  };
  const rootB: TNode = {
    m: { k: "#root", y: 0, d: "s" } as Marker,
    kids: buildForest(mb),
  };
  alignPair(rootA, rootB);
  return P;

  function alignPair(a: TNode, b: TNode): [number, number] {
    if (a.kids.length === 0 || b.kids.length === 0) return [0, 0];
    const mode = arrange(a, b);
    if (mode === "g") return alignGrid(a, b);
    if (mode === "r") return alignRow(a.kids, b.kids);
    return alignStack(a, b);
  }

  /** Stacked children: align each matched top in turn; a one-sided child reserves
   *  its height on the other side (deferred to the next match, or grown onto the
   *  container bottom when it is the tail). */
  function alignStack(a: TNode, b: TNode): [number, number] {
    let fA = 0;
    let fB = 0;
    let pendA = 0;
    let pendB = 0;
    for (const [ca, cb] of pairChildren(a.kids, b.kids)) {
      if (ca && cb) {
        if (pendA) {
          pushNode(P.a, ca, pendA);
          fA += pendA;
          pendA = 0;
        }
        if (pendB) {
          pushNode(P.b, cb, pendB);
          fB += pendB;
          pendB = 0;
        }
        const d = top(ca) - top(a) + fA - (top(cb) - top(b) + fB);
        if (d > 0.5) {
          pushNode(P.b, cb, d);
          fB += d;
        } else if (d < -0.5) {
          pushNode(P.a, ca, -d);
          fA += -d;
        }
        const [addA, addB] = alignPair(ca, cb);
        fA += addA;
        fB += addB;
      } else if (ca) {
        pendB += H(ca);
      } else if (cb) {
        pendA += H(cb);
      }
    }
    if (pendA) {
      growNode(P.a, a, pendA);
      fA += pendA;
    }
    if (pendB) {
      growNode(P.b, b, pendB);
      fB += pendB;
    }
    return [fA, fB];
  }

  /** A row of columns (cells): recurse each matched column (tops shared), then
   *  grow every column's shorter side up to the tallest so the row bottom lines
   *  up. Returns the row's per-side growth for the caller's flow. */
  function alignRow(ak: TNode[], bk: TNode[]): [number, number] {
    const cols: Array<{ ca: TNode; cb: TNode; hA: number; hB: number }> = [];
    const pairs = pairChildren(ak, bk);
    for (let k = 0; k < pairs.length; k++) {
      const [ca, cb] = pairs[k];
      if (ca && cb) {
        const [addA, addB] = alignPair(ca, cb);
        cols.push({ ca, cb, hA: H(ca) + addA, hB: H(cb) + addB });
      } else if (ca && !cb) {
        const nb = nextSide(pairs, k, 1);
        if (nb) emit(P.b, firstLeaf(nb).m.i, 1, "cell");
      } else if (cb && !ca) {
        const na = nextSide(pairs, k, 0);
        if (na) emit(P.a, firstLeaf(na).m.i, 1, "cell");
      }
    }
    const rowH = cols.reduce((mx, c) => Math.max(mx, c.hA, c.hB), 0);
    for (const c of cols) {
      growNode(P.a, c.ca, rowH - c.hA);
      growNode(P.b, c.cb, rowH - c.hB);
    }
    const hA0 = ak.reduce((mx, k) => Math.max(mx, H(k)), 0);
    const hB0 = bk.reduce((mx, k) => Math.max(mx, H(k)), 0);
    return [rowH - hA0, rowH - hB0];
  }

  /** A 2-D grid: align rows positionally as a stack (push a whole row's cells to
   *  align its top), each row aligned as a row of columns. */
  function alignGrid(a: TNode, b: TNode): [number, number] {
    const ra = rowsOf(a.kids);
    const rb = rowsOf(b.kids);
    let fA = 0;
    let fB = 0;
    const n = Math.min(ra.length, rb.length);
    for (let r = 0; r < n; r++) {
      const rowA = ra[r];
      const rowB = rb[r];
      const d = rowTop(rowA) - top(a) + fA - (rowTop(rowB) - top(b) + fB);
      if (d > 0.5) {
        for (const c of rowB) pushNode(P.b, c, d);
        fB += d;
      } else if (d < -0.5) {
        for (const c of rowA) pushNode(P.a, c, -d);
        fA += -d;
      }
      const [addA, addB] = alignRow(rowA, rowB);
      fA += addA;
      fB += addB;
    }
    for (let r = n; r < ra.length; r++) {
      const h = rowBot(ra[r]) - rowTop(ra[r]);
      for (const c of rb[rb.length - 1] ?? []) growNode(P.b, c, h);
      fB += h;
    }
    for (let r = n; r < rb.length; r++) {
      const h = rowBot(rb[r]) - rowTop(rb[r]);
      for (const c of ra[ra.length - 1] ?? []) growNode(P.a, c, h);
      fA += h;
    }
    return [fA, fB];
  }

  function nextSide(
    pairs: Array<[TNode | null, TNode | null]>,
    from: number,
    side: 0 | 1,
  ): TNode | null {
    for (let j = from + 1; j < pairs.length; j++)
      if (pairs[j][side]) return pairs[j][side];
    return null;
  }
};
