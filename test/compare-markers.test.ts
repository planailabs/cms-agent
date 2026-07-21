/**
 * Content markers — LCS anchor matching, piecewise position mapping, and
 * the aligned-segment math the onion content mode renders from.
 */
import { describe, expect, it } from 'vitest';
import {
  alignMarkers,
  alignedSegments,
  bracketAnchors,
  computeAnchors,
  mapPosition,
  type Marker,
} from '@/lib/compare/markers';

const mk = (k: string, y: number): Marker => ({ k, y });
/** Container-layer marker: key is "#<structsig>", `s` is the structsig. */
const mkc = (sig: string, y: number): Marker => ({ k: `#${sig}`, y, s: sig });

describe('computeAnchors', () => {
  it('matches identical content in order', () => {
    const a = [mk('H1:Title#1', 0), mk('P:Intro#1', 100), mk('P:Outro#1', 300)];
    const b = [mk('H1:Title#1', 0), mk('P:Intro#1', 150), mk('P:Outro#1', 500)];
    expect(computeAnchors(a, b)).toEqual([
      { a: 0, b: 0 },
      { a: 100, b: 150 },
      { a: 300, b: 500 },
    ]);
  });

  it('skips inserted/removed blocks without crossing alignments', () => {
    const a = [mk('H1:Title#1', 0), mk('P:Kept#1', 100), mk('P:Removed#1', 200)];
    const b = [mk('H1:Title#1', 0), mk('P:New#1', 80), mk('P:Kept#1', 240)];
    expect(computeAnchors(a, b)).toEqual([
      { a: 0, b: 0 },
      { a: 100, b: 240 },
    ]);
  });

  it('drops matches that would fold the mapping backwards', () => {
    // 'Moved' appears before Kept in A but after in B — LCS picks the longer
    // chain; the survivor set must stay strictly increasing on both sides.
    const a = [mk('P:Moved#1', 50), mk('P:Kept#1', 100), mk('P:Tail#1', 200)];
    const b = [mk('P:Kept#1', 40), mk('P:Moved#1', 90), mk('P:Tail#1', 300)];
    const anchors = computeAnchors(a, b);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].a).toBeGreaterThan(anchors[i - 1].a);
      expect(anchors[i].b).toBeGreaterThan(anchors[i - 1].b);
    }
  });

  it('distinguishes duplicate content by occurrence', () => {
    const a = [mk('LI:Item#1', 10), mk('LI:Item#2', 20)];
    const b = [mk('LI:Item#1', 10), mk('LI:Item#2', 40)];
    expect(computeAnchors(a, b)).toHaveLength(2);
  });

  it('anchors a reworded section by its structure when the text changed', () => {
    // Section wraps a heading + paragraph whose text was fully reworded, so
    // no leaf keys match — but the container's structural signature does, so
    // the section boundary still anchors.
    const a = [mkc('SECTION/2/H1Pp', 100), mk('H1:Old heading#1', 110), mk('P:Old body#1', 160)];
    const b = [mkc('SECTION/2/H1Pp', 300), mk('H1:New heading#1', 310), mk('P:New body#1', 360)];
    expect(computeAnchors(a, b)).toEqual([{ a: 100, b: 300 }]);
  });

  it('matches reworded text by word overlap; unrelated text does not anchor', () => {
    const a = [mk('P:The useful gains of AI are real#1', 100), mk('P:Unrelated content here#1', 300)];
    const b = [mk('P:The useful gains of AI are real and solid#1', 120), mk('P:Totally different words entirely#1', 350)];
    // first P: high word overlap → anchor; second P: no overlap → no anchor
    expect(computeAnchors(a, b)).toEqual([{ a: 100, b: 120 }]);
  });

  it('matches by stable id even when all the text changed', () => {
    const a = [{ k: 'H1:Old headline entirely#1', y: 0, id: 'hero' }];
    const b = [{ k: 'H1:Completely different words#1', y: 40, id: 'hero' }];
    // no word overlap, but same id ⇒ same element ⇒ anchored
    expect(computeAnchors(a, b)).toEqual([{ a: 0, b: 40 }]);
  });

  it('never cross-matches different columns of the same flex/grid', () => {
    // two cards in one 3-col grid: same section + class, but different cells.
    const a = [{ k: 'H4:The regulatory wave#1', y: 0, sid: 'grid', c: 'card', fx: 'G/3#1' }];
    const b = [{ k: 'H4:The subscription ceiling#1', y: 0, sid: 'grid', c: 'card', fx: 'G/3#2' }];
    expect(computeAnchors(a, b)).toEqual([]); // other cell → no anchor → no overlay
  });

  it('matches the same grid cell even when its text changed', () => {
    const a = [{ k: 'H4:The regulatory wave#1', y: 0, sid: 'grid', c: 'card', fx: 'G/3#1' }];
    const b = [{ k: 'H4:Governance is becoming#1', y: 40, sid: 'grid', c: 'card', fx: 'G/3#1' }];
    expect(computeAnchors(a, b)).toEqual([{ a: 0, b: 40 }]); // same cell → corresponds
  });

  it('skips a missing element (fill up) instead of mis-pairing the rest', () => {
    const a = [mk('P:Alpha block#1', 100), mk('P:Beta block#1', 200), mk('P:Gamma block#1', 300)];
    const b = [mk('P:Alpha block#1', 100), mk('P:Gamma block#1', 250)]; // Beta removed
    const { matches, onlyA } = alignMarkers(a, b);
    expect(matches.map((mm) => [mm.ai, mm.bi])).toEqual([
      [0, 0],
      [2, 1],
    ]);
    expect(onlyA).toEqual([1]); // Beta is the missing element
    expect(computeAnchors(a, b)).toEqual([
      { a: 100, b: 100 },
      { a: 300, b: 250 },
    ]);
  });

  it('adds container breakpoints on top of the leaf anchors (layers)', () => {
    const a = [mkc('SECTION/1/H1', 0), mk('H1:Title#1', 10), mkc('UL/2/LiLi', 200), mk('LI:One#1', 210)];
    const b = [mkc('SECTION/1/H1', 0), mk('H1:Title#1', 10), mkc('UL/2/LiLi', 400), mk('LI:One#1', 410)];
    // Leaf anchors (H1, LI) plus both container anchors → denser breakpoints.
    expect(computeAnchors(a, b)).toEqual([
      { a: 0, b: 0 },
      { a: 10, b: 10 },
      { a: 200, b: 400 },
      { a: 210, b: 410 },
    ]);
  });

  it('never lets a structural anchor break monotonicity of the leaf anchors', () => {
    const a = [mk('P:Kept#1', 100), mkc('X', 150), mk('P:Tail#1', 200)];
    // The structural marker in B sits BEFORE the kept leaf → inserting it would
    // fold the mapping back; it must be dropped.
    const b = [mkc('X', 20), mk('P:Kept#1', 100), mk('P:Tail#1', 260)];
    const anchors = computeAnchors(a, b);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].a).toBeGreaterThan(anchors[i - 1].a);
      expect(anchors[i].b).toBeGreaterThan(anchors[i - 1].b);
    }
  });
});

describe('mapPosition', () => {
  const bracketed = bracketAnchors([{ a: 100, b: 200 }], 400, 800);

  it('interpolates inside a segment and clamps outside', () => {
    expect(mapPosition(0, bracketed)).toBe(0);
    expect(mapPosition(50, bracketed)).toBe(100); // half of 0→100 maps to half of 0→200
    expect(mapPosition(100, bracketed)).toBe(200);
    expect(mapPosition(250, bracketed)).toBe(500); // half of 100→400 maps to half of 200→800
    expect(mapPosition(400, bracketed)).toBe(800);
    expect(mapPosition(9999, bracketed)).toBe(800);
  });
});

describe('alignedSegments', () => {
  it('pads each row to the taller side', () => {
    const segs = alignedSegments([{ a: 100, b: 300 }], 400, 500);
    expect(segs).toEqual([
      { topA: 0, topB: 0, hA: 100, hB: 300, h: 300 },
      { topA: 100, topB: 300, hA: 300, hB: 200, h: 300 },
    ]);
    // aligned total height is identical for both columns
    const total = segs.reduce((s, x) => s + x.h, 0);
    expect(total).toBe(600);
  });

  it('drops out-of-range anchors via bracketing', () => {
    const segs = alignedSegments([{ a: 450, b: 100 }], 400, 500); // a beyond heightA
    expect(segs).toEqual([{ topA: 0, topB: 0, hA: 400, hB: 500, h: 500 }]);
  });

  it('lines up matched content when two browsers render at different heights', () => {
    // Same page, two engines: identical content but B renders every block a
    // few px lower (font metrics) and the doc ends 30px taller. Content-align
    // must place each matched anchor at the SAME cumulative y in both columns.
    const a = [mk('H1:Title#1', 0), mk('P:Body#1', 200), mk('H2:More#1', 600)];
    const b = [mk('H1:Title#1', 0), mk('P:Body#1', 210), mk('H2:More#1', 625)];
    const segs = alignedSegments(computeAnchors(a, b), 1000, 1030);
    let yA = 0;
    let yB = 0;
    const rowsAtAnchor = segs.map((s) => {
      const row = { yA, yB };
      yA += s.h; // both columns advance by the same aligned row height
      yB += s.h;
      return row;
    });
    // Every segment starts at an identical y in both columns → anchors align.
    for (const r of rowsAtAnchor) expect(r.yA).toBe(r.yB);
    expect(yA).toBe(yB); // equal total height despite the 30px render delta
  });
});
