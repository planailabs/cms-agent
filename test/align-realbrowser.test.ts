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

/** Run the full pipeline for base vs base+mutate; return residual y drift. */
const residual = async (mutate: () => void): Promise<{ max: number; worst: unknown }> => {
  const before = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const after = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await before.setContent(base);
    await after.setContent(base);
    await after.evaluate(mutate);
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
