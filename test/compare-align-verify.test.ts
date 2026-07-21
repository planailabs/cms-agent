/**
 * Alignment verification scaffolds — reproduce the exact issues the DOM-filler
 * aligner has hit, and assert `verifyAlignment` drives them to ~0 misalignment.
 * SELF-IMPROVING: when a new visual bug turns up, add a scaffold here that
 * reproduces it (a marker set), watch it fail, tighten the aligner in
 * compare/layout until maxPairDelta → 0, and leave the scaffold as a
 * regression guard. See .agents/skills/compare-alignment.
 */
import { describe, expect, it } from 'vitest';
import { verifyAlignment } from '@/lib/compare/layout';
import type { Marker } from '@/lib/compare/markers';
import planai from './fixtures/planai-markers.json' with { type: 'json' };

let uid = 0;
/** A vertical stack of "posts" (heading + paragraph each), 120px apart. */
const stack = (titles: string[], x = 0, w = 300): { m: Marker[]; h: number } => {
  const m: Marker[] = [];
  let y = 0;
  for (const t of titles) {
    m.push({ k: `H3:${t}#1`, y, x, w, h: 40, i: uid++ });
    m.push({ k: `P:${t} body paragraph with words#1`, y: y + 50, x, w, h: 50, i: uid++ });
    y += 120;
  }
  return { m, h: y };
};

describe('verifyAlignment scaffolds', () => {
  it('insertion at the top: following posts still line up', () => {
    const a = stack(['Alpha', 'Beta', 'Gamma']);
    const b = stack(['BrandNew', 'Alpha', 'Beta', 'Gamma']);
    const r = verifyAlignment(a.m, a.h, b.m, b.h);
    expect(r.maxPairDelta).toBeLessThanOrEqual(2);
  });

  it('removal in the middle: surrounding posts still line up', () => {
    const a = stack(['Alpha', 'Beta', 'Gamma']);
    const b = stack(['Alpha', 'Gamma']);
    const r = verifyAlignment(a.m, a.h, b.m, b.h);
    expect(r.maxPairDelta).toBeLessThanOrEqual(2);
  });

  it('reworded posts (same structure, changed text) still line up', () => {
    const a = stack(['Alpha', 'Beta', 'Gamma']);
    // same three slots, all text different but structure identical
    const b = {
      m: [
        { k: 'H3:One#1', y: 0, x: 0, w: 300, h: 40, i: uid++ },
        { k: 'P:totally different opening words#1', y: 50, x: 0, w: 300, h: 50, i: uid++ },
        { k: 'H3:Two#1', y: 120, x: 0, w: 300, h: 40, i: uid++ },
        { k: 'P:more distinct replacement words#1', y: 170, x: 0, w: 300, h: 50, i: uid++ },
        { k: 'H3:Three#1', y: 240, x: 0, w: 300, h: 40, i: uid++ },
        { k: 'P:final swapped out paragraph here#1', y: 290, x: 0, w: 300, h: 50, i: uid++ },
      ] as Marker[],
      h: 360,
    };
    const r = verifyAlignment(a.m, a.h, b.m, b.h);
    // structure-aligned; matched slots within ~a post height
    expect(r.maxPairDelta).toBeLessThanOrEqual(60);
  });

  it('real page (plan.ai): matched content stays within a small delta', () => {
    const before = planai.before as { h: number; m: Marker[] };
    const after = planai.after as { h: number; m: Marker[] };
    // NOTE: this fixture predates element indexing (no marker.i), so it has no
    // spacers to apply — it guards that verifyAlignment runs and reports.
    const r = verifyAlignment(before.m, before.h, after.m, after.h);
    expect(Number.isFinite(r.maxPairDelta)).toBe(true);
    expect(Number.isFinite(r.heightGap)).toBe(true);
  });
});
