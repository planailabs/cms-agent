/**
 * 2-D rectangle-split layout: partition into rectangles by guillotine cuts,
 * match the two trees, and align each rectangle on its own.
 */
import { describe, expect, it } from 'vitest';
import { boxDiff, buildLayout } from '@/lib/compare/layout';
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

  it('classifies added / removed / changed content boxes', () => {
    const a = [
      bx('P:kept intact#1', 0, 0, 100, 40),
      bx('P:oldonly removed line#1', 60, 0, 100, 40),
      bx('P:the useful gains of AI are real#1', 120, 0, 100, 40),
    ];
    const b = [
      bx('P:kept intact#1', 0, 0, 100, 40),
      bx('P:the useful gains of AI are solid#1', 80, 0, 100, 60), // reworded (>0.5 overlap)
      bx('P:a totally brand new sentence#1', 160, 0, 100, 40),
    ];
    const kinds = boxDiff(a, 200, b, 220).map((d) => d.kind);
    expect(kinds).toContain('added'); // brandnew
    expect(kinds).toContain('removed'); // oldonly
    expect(kinds).toContain('changed'); // reworded paragraph
    expect(kinds).not.toContain(undefined);
  });

  it('inserts a hierarchy-correct filler for a block added at the top (no index shift)', () => {
    const card = (title: string, y: number) => bx(`P:${title}#1`, y, 0, 300, 40);
    const a = [card('alpha post', 0), card('beta post', 60), card('gamma post', 120)];
    // same three, plus a brand-new card inserted at the TOP
    const b = [card('brand new post', 0), card('alpha post', 60), card('beta post', 120), card('gamma post', 180)];
    const n = buildLayout(a, 160, b, 220)!;
    expect(n.kind).toBe('col');
    expect(n.children).toHaveLength(4);
    // first child is added: zero height on side A (a filler), content on side B
    const first = n.children![0];
    expect(first.kind).toBe('leaf');
    expect(first.segs![0].hA).toBe(0);
    expect(first.segs![0].hB).toBeGreaterThan(0);
    // and the rest align 1:1 (both sides have real content)
    expect(n.children![1].segs?.some((s) => s.hA > 0 && s.hB > 0) ?? true).toBe(true);
  });

  it('falls back to a single leaf when the two structures do not match', () => {
    // A is a two-column row, B is one stacked block → shapes differ → leaf.
    const a = [bx('P:l#1', 0, 0, 100, 50), bx('P:r#1', 0, 140, 100, 50)];
    const b = [bx('P:l#1', 0, 0, 300, 50)];
    const n = buildLayout(a, 60, b, 60)!;
    expect(n.kind).toBe('leaf');
  });
});
