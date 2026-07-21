/**
 * 2-D rectangle-split layout: partition into rectangles by guillotine cuts,
 * match the two trees, and align each rectangle on its own.
 */
import { describe, expect, it } from 'vitest';
import { buildLayout } from '@/lib/compare/layout';
import type { Marker } from '@/lib/compare/markers';

const bx = (k: string, y: number, x: number, w: number, h: number): Marker => ({ k, y, x, w, h, s: '' });

describe('buildLayout', () => {
  it('returns null when markers lack bounding boxes (old caches)', () => {
    const a = [{ k: 'P:a#1', y: 0 }];
    const b = [{ k: 'P:a#1', y: 0 }];
    expect(buildLayout(a, 100, b, 100)).toBeNull();
  });

  it('stacks full-width blocks into a col', () => {
    const a = [bx('P:one#1', 0, 0, 300, 50), bx('P:two#1', 60, 0, 300, 40)];
    const b = [bx('P:one#1', 0, 0, 300, 50), bx('P:two#1', 70, 0, 300, 60)];
    const n = buildLayout(a, 100, b, 130)!;
    expect(n.kind).toBe('col');
    expect(n.children).toHaveLength(2);
  });

  it('splits a two-column grid into a row and expands each column on its own', () => {
    // col1 grows in B, col2 grows in A → the filler lands in different columns.
    const a = [
      bx('H:c1#1', 0, 0, 100, 30),
      bx('P:c1#1', 40, 0, 100, 100),
      bx('H:c2#1', 0, 140, 100, 30),
      bx('P:c2#1', 40, 140, 100, 200),
    ];
    const b = [
      bx('H:c1#1', 0, 0, 100, 30),
      bx('P:c1#1', 40, 0, 100, 180),
      bx('H:c2#1', 0, 140, 100, 30),
      bx('P:c2#1', 40, 140, 100, 120),
    ];
    const n = buildLayout(a, 240, b, 220)!;
    expect(n.kind).toBe('row'); // vertical gap (x 100→140) splits first
    expect(n.children).toHaveLength(2);
    // both columns aligned to the same (row) height, so the row is rectangular
    expect(n.children![0].h).toBe(n.children![1].h);
    expect(n.h).toBe(n.children![0].h);
    // each column itself split its heading from its paragraph
    expect(n.children![0].kind).toBe('col');
  });

  it('falls back to a single leaf when the two structures do not match', () => {
    // A is a two-column row, B is one stacked block → shapes differ → leaf.
    const a = [bx('P:l#1', 0, 0, 100, 50), bx('P:r#1', 0, 140, 100, 50)];
    const b = [bx('P:l#1', 0, 0, 300, 50)];
    const n = buildLayout(a, 60, b, 60)!;
    expect(n.kind).toBe('leaf');
  });
});
