/** Pure element-edit helpers: hit-testing, stroke bbox, delete + renumber. */
import { describe, expect, it } from 'vitest';
import {
  hitTestAnnotations,
  removeAnnotation,
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
