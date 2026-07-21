/**
 * Real-browser alignment reproductions. Renders a base page and a mutated copy
 * (one edit per case — the "two folders with a modification between them"),
 * runs the ACTUAL pipeline in Playwright (collect markers → spacingPlan → inject
 * spacers → re-collect), and asserts matched content ends up at the same y.
 *
 * Self-improving: to reproduce a new visual bug, add a mutation below, watch the
 * residual delta, then tighten compare/layout until it's ~0. Structure/classes/
 * ids are borrowed from the plan.ai site (test/fixtures/align/base.html).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Headless chromium in the nix/container env — skip host-lib validation.
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { COLLECT_MARKERS_JS, type MarkerDoc } from '@/lib/compare/markers';
import { spacingPlan, matchedYDelta } from '@/lib/compare/layout';
import { INJECT_SPACERS } from '@/lib/compare/inject';

const base = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/align/base.html'),
  'utf8',
);

let browser: Browser;
beforeAll(async () => {
  const pw = await import('playwright');
  browser = await pw.chromium.launch({ chromiumSandbox: false });
});
afterAll(async () => browser?.close());

const collect = (p: Page) => p.evaluate(COLLECT_MARKERS_JS) as Promise<MarkerDoc>;

/** Run the full pipeline for base vs base+mutate; return residual y drift.
 *  `mutate` runs in the browser; `arg` (JSON-serialisable) is passed to it. */
const residual = async (
  mutate: (arg?: unknown) => void,
  arg?: unknown,
): Promise<{ max: number; worst: unknown }> => {
  const before = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const after = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await before.setContent(base);
    await after.setContent(base);
    await after.evaluate(mutate, arg);
    const [mb, ma] = await Promise.all([collect(before), collect(after)]);
    const plan = spacingPlan(mb.m, mb.h, ma.m, ma.h);
    await before.evaluate(INJECT_SPACERS, plan.a as never);
    await after.evaluate(INJECT_SPACERS, plan.b as never);
    const [ab, aa] = await Promise.all([collect(before), collect(after)]);
    const { max, worst } = matchedYDelta(ab.m, aa.m);
    return { max: Math.abs(max), worst };
  } finally {
    await Promise.all([before.close(), after.close()]);
  }
};

// Each mutation runs IN THE BROWSER (no closures over Node scope).
const cases: Array<{ name: string; mutate: () => void; max: number }> = [
  { name: 'reword a post body', max: 4, mutate: () => {
    (document.querySelectorAll('.post .swiss-body')[0] as HTMLElement).textContent =
      'A completely rewritten body for this first post, a little longer than before.';
  } },
  { name: 'insert a post at the top', max: 4, mutate: () => {
    document.querySelector('.posts')!.insertAdjacentHTML('afterbegin',
      '<li class="post"><p class="date">Jul 19, 2026</p><h3 class="swiss-heading-md">What Squirrels Know</h3><p class="swiss-body">Good ideas rarely arrive fully formed; collect the small promising things.</p></li>');
  } },
  { name: 'remove a middle post', max: 4, mutate: () => {
    document.querySelectorAll('.post')[1].remove();
  } },
  { name: 'grow the hero paragraph', max: 4, mutate: () => {
    (document.querySelector('#hero .swiss-body-lg') as HTMLElement).textContent =
      'A much longer hero paragraph that now wraps across several lines and pushes everything below it down by a meaningful amount, testing full-page vertical realignment end to end.';
  } },
  { name: 'insert a whole new section', max: 4, mutate: () => {
    document.querySelector('#journal')!.insertAdjacentHTML('beforebegin',
      '<section id="quotes"><h2 class="swiss-heading-lg">In their words</h2><p class="swiss-body">A brand new section inserted between features and journal.</p></section>');
  } },
  { name: 'remove a grid card', max: 6, mutate: () => {
    document.querySelectorAll('.card')[1].remove();
  } },
  { name: 'change nested card heading', max: 4, mutate: () => {
    (document.querySelectorAll('.card h3')[1] as HTMLElement).textContent = 'Insight';
  } },
  { name: 'add a table row', max: 4, mutate: () => {
    document.querySelector('table')!.insertAdjacentHTML('beforeend',
      '<tr><td>Comments</td><td>50</td><td>210</td></tr>');
  } },
  { name: 'change a table cell', max: 4, mutate: () => {
    (document.querySelectorAll('td')[1] as HTMLElement).textContent = '9,999';
  } },
  { name: 'grow a department card (grid row height)', max: 6, mutate: () => {
    // Lengthen ONE row-1 card's body → its whole grid row grows taller, pushing
    // row 2 (Growth/Build/Process) down together. Command must stay aligned with
    // its row and row 2 must move as a unit, not per-column.
    (document.querySelectorAll('.dept .swiss-body')[1] as HTMLElement).textContent =
      'Monitors markets, digests research, scans competitors, benchmarks pricing, tracks sentiment, and produces briefed intelligence rather than raw data dumps that nobody has time to read.';
  } },
  { name: 'remove a department card (row 2, filler cell)', max: 6, mutate: () => {
    // Remove a row-2 card: later cards in that row shift left; a filler grid cell
    // keeps them in place. No card crosses a row boundary.
    document.querySelectorAll('.dept')[4].remove();
  } },
  { name: 'grow an inline-block column (no flex/grid)', max: 6, mutate: () => {
    // A plain inline-block column row: no stretch coupling, so growing one column
    // only pushes the content BELOW the row down by the new tallest height. The
    // filler must land as a flow div (not margin-top / not a grid tail).
    (document.querySelectorAll('.col .swiss-body')[0] as HTMLElement).textContent =
      'A short inline-block column that has now been expanded with a good deal more text so that it wraps onto several lines and becomes the tallest column in this row by a clear margin.';
  } },
  { name: 'multiple simultaneous edits', max: 6, mutate: () => {
    document.querySelector('.posts')!.insertAdjacentHTML('afterbegin',
      '<li class="post"><p class="date">Jul 19, 2026</p><h3 class="swiss-heading-md">What Squirrels Know</h3><p class="swiss-body">Collect the small promising things.</p></li>');
    (document.querySelectorAll('td')[3] as HTMLElement).textContent = '42';
    (document.querySelector('#hero .swiss-body-lg') as HTMLElement).textContent =
      'A longer hero paragraph that wraps to a second line here.';
  } },
];

describe('real-browser alignment', () => {
  for (const c of cases) {
    it(`${c.name} → matched content aligns`, async () => {
      const r = await residual(c.mutate);
      if (r.max > c.max) console.warn(`[align:${c.name}] residual ${r.max}px`, JSON.stringify(r.worst));
      expect(r.max).toBeLessThanOrEqual(c.max);
    }, 30_000);
  }
});

// ── Chaos: random combinations of edits, seeded for reproducibility ──────────
// A seeded PRNG builds an op list per seed; on failure the seed + ops are logged
// so any regression is a one-line repro. Ops are data (interpreted in-browser),
// never closures. Deliberately excludes removing a row-1 grid card — that is a
// genuine 2-D row-major reflow (a later card pulls up a whole row), the one
// documented limitation of a height-based aligner (see SKILL.md).

/** mulberry32 — tiny deterministic PRNG so a failing seed reproduces exactly. */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Op { kind: string; n?: number; text?: string }
const LOREM =
  'the small promising things collect momentum clarity and care across every function and channel over time';
const words = (r: () => number, min: number, max: number): string => {
  const parts = LOREM.split(' ');
  const count = min + Math.floor(r() * (max - min));
  let s = '';
  for (let i = 0; i < count; i++) s += parts[Math.floor(r() * parts.length)] + ' ';
  return s.trim() + '.';
};

const OP_KINDS = [
  'rewordPost', 'insertPost', 'removePost', 'growHero', 'rewordDept',
  'removeDeptRow2', 'growCol', 'addTableRow', 'changeCell',
];

/** Build a random op list for a seed. */
const buildOps = (seed: number): Op[] => {
  const r = rng(seed);
  const n = 2 + Math.floor(r() * 4); // 2..5 simultaneous edits
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const kind = OP_KINDS[Math.floor(r() * OP_KINDS.length)];
    ops.push({ kind, n: Math.floor(r() * 3), text: words(r, 6, 24) });
  }
  return ops;
};

/** Apply an op list in the browser. Defensive: skips ops whose target is gone. */
const applyOps = (ops: Array<{ kind: string; n?: number; text?: string }>): void => {
  const at = (sel: string, i: number) => document.querySelectorAll(sel)[i] as HTMLElement | undefined;
  for (const op of ops) {
    const i = op.n ?? 0;
    const t = op.text ?? 'Changed.';
    if (op.kind === 'rewordPost') { const e = at('.post .swiss-body', i); if (e) e.textContent = t; }
    else if (op.kind === 'insertPost') document.querySelector('.posts')?.insertAdjacentHTML('afterbegin',
      `<li class="post"><p class="date">Jul 19, 2026</p><h3 class="swiss-heading-md">New Note</h3><p class="swiss-body">${t}</p></li>`);
    else if (op.kind === 'removePost') at('.post', i)?.remove();
    else if (op.kind === 'growHero') { const e = document.querySelector('#hero .swiss-body-lg') as HTMLElement | null; if (e) e.textContent = t + ' ' + t; }
    else if (op.kind === 'rewordDept') { const e = at('.dept .swiss-body', i); if (e) e.textContent = t + ' ' + t; }
    else if (op.kind === 'removeDeptRow2') at('.dept', 3 + i)?.remove(); // rows 2 only (indices 3..5)
    else if (op.kind === 'growCol') { const e = at('.col .swiss-body', i); if (e) e.textContent = t + ' ' + t + ' ' + t; }
    else if (op.kind === 'addTableRow') document.querySelector('table')?.insertAdjacentHTML('beforeend',
      `<tr><td>Row</td><td>${i}</td><td>${t.slice(0, 8)}</td></tr>`);
    else if (op.kind === 'changeCell') { const e = at('td', i); if (e) e.textContent = t.slice(0, 6); }
  }
};

describe('real-browser alignment — chaos', () => {
  for (let seed = 1; seed <= 16; seed++) {
    it(`seed ${seed} → matched content aligns`, async () => {
      const ops = buildOps(seed);
      const r = await residual(applyOps as never, ops);
      if (r.max > 8) console.warn(`[chaos:${seed}] residual ${r.max}px ops=${JSON.stringify(ops)} worst=${JSON.stringify(r.worst)}`);
      expect(r.max).toBeLessThanOrEqual(8);
    }, 30_000);
  }
});
