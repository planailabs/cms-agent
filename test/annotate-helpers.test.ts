/** Pure element-edit helpers: hit-testing, stroke bbox, delete + renumber. */
import { describe, expect, it } from 'vitest';
import {
  annotationCount,
  hitTestAnnotations,
  removeAnnotation,
  snapAnchorsFromRects,
  snapDelta,
  strokeBbox,
  strokeHitIndex,
  type EditAnnotations,
} from '@/injected/annotate';

const base = (): EditAnnotations => ({
  url: 'https://x/',
  route: '/',
  viewport: { width: 1280, height: 900 },
  moves: [
    {
      selector: 'main > h1',
      element: { tag: 'h1' },
      dx: 100,
      dy: 50,
      rect: { x: 10, y: 10, w: 200, h: 40 },
    },
  ],
  strokes: [{ points: [[300, 300], [400, 300]] }],
  comments: [
    { n: 1, x: 600, y: 100, text: 'first' },
    { n: 2, x: 700, y: 100, text: 'second' },
  ],
});

describe('hitTestAnnotations', () => {
  it('hits pins within radius, strokes within tolerance, moves at their translated rect', () => {
    const a = base();
    expect(hitTestAnnotations(a, 610, 105)).toEqual({ kind: 'comment', index: 0 });
    // Between the stroke's points, 6px off the line
    expect(hitTestAnnotations(a, 350, 306)).toEqual({ kind: 'stroke', index: 0 });
    expect(strokeHitIndex(a.strokes, 350, 320)).toBe(-1);
    // Original rect (10,10) no longer hits — the element moved by (100,50)
    expect(hitTestAnnotations(a, 20, 20)).toBeNull();
    expect(hitTestAnnotations(a, 120, 70)).toEqual({ kind: 'move', index: 0 });
    expect(hitTestAnnotations(a, 5, 500)).toBeNull();
  });

  it('prefers pins over strokes when they overlap', () => {
    const a = base();
    a.comments.push({ n: 3, x: 350, y: 300, text: 'on the line' });
    expect(hitTestAnnotations(a, 350, 302)).toEqual({ kind: 'comment', index: 2 });
  });
});

describe('strokeBbox + removeAnnotation', () => {
  it('computes the bounding box of a polyline', () => {
    expect(strokeBbox({ points: [[10, 20.4], [50, 44], [30, 12]] })).toEqual({
      x: 10,
      y: 12,
      w: 40,
      h: 32,
    });
  });

  it('deletes by kind/index and renumbers comment pins to 1..N', () => {
    const a = base();
    removeAnnotation(a, { kind: 'comment', index: 0 });
    expect(a.comments).toEqual([{ n: 1, x: 700, y: 100, text: 'second' }]);
    removeAnnotation(a, { kind: 'move', index: 0 });
    expect(a.moves).toHaveLength(0);
    removeAnnotation(a, { kind: 'stroke', index: 0 });
    expect(a.strokes).toHaveLength(0);
  });
});

describe('snap-to-align', () => {
  const anchors = snapAnchorsFromRects([{ x: 100, y: 200, w: 50, h: 30 }]);

  it('collects edge + center axes from rects', () => {
    expect(anchors.xs).toEqual([100, 125, 150]);
    expect(anchors.ys).toEqual([200, 215, 230]);
  });

  it('snaps within tolerance and reports the guide axis', () => {
    // Dragged left edge at 96 (rect.x 0 + dx 96) — 4px from anchor 100
    const r = snapDelta({ x: 0, y: 0, w: 20, h: 20 }, 96, 300, anchors);
    expect(r.dx).toBe(100);
    expect(r.guideX).toBe(100);
    expect(r.dy).toBe(300); // no y anchor within 6px
    expect(r.guideY).toBeNull();
  });

  it('prefers the nearest anchor across edges and centers', () => {
    // x: center edge 124 is 1px from anchor 125 (beats everything else)
    // y: bottom edge 228 is 2px from 230; middle 218 is 3px from 215 → bottom wins
    const r = snapDelta({ x: 0, y: 0, w: 20, h: 20 }, 114, 208, anchors);
    expect(r.dx).toBe(115);
    expect(r.guideX).toBe(125);
    expect(r.dy).toBe(210);
    expect(r.guideY).toBe(230);
  });

  it('leaves the delta alone with no anchor in range', () => {
    const r = snapDelta({ x: 0, y: 0, w: 20, h: 20 }, 500, 500, anchors);
    expect(r).toEqual({ dx: 500, dy: 500, guideX: null, guideY: null });
  });
});

describe('swap annotations', () => {
  const withSwap = (): EditAnnotations => ({
    ...base(),
    swaps: [
      {
        a: { selector: '.hero', element: { tag: 'div' }, rect: { x: 900, y: 400, w: 100, h: 50 } },
        b: { selector: '.cta', element: { tag: 'div' }, rect: { x: 900, y: 600, w: 100, h: 50 } },
      },
    ],
  });

  it('hit-tests either endpoint and deletes the pair', () => {
    const a = withSwap();
    expect(hitTestAnnotations(a, 950, 425)).toEqual({ kind: 'swap', index: 0 });
    expect(hitTestAnnotations(a, 950, 625)).toEqual({ kind: 'swap', index: 0 });
    removeAnnotation(a, { kind: 'swap', index: 0 });
    expect(a.swaps).toEqual([]);
  });

  it('counts swaps and tolerates pre-swap annotation sets', () => {
    expect(annotationCount(withSwap())).toBe(5); // 1 move + 1 swap + 1 stroke + 2 comments
    const legacy = base();
    delete legacy.swaps;
    expect(annotationCount(legacy)).toBe(4);
    expect(hitTestAnnotations(legacy, 950, 425)).toBeNull();
  });
});
