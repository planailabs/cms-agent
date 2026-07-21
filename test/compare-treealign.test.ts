/**
 * Recursive both-trees aligner (compare/treeAlign) — a WIP ALTERNATIVE to the
 * geometric guillotine (compare/layout `spacingPlan`), NOT wired into the shipped
 * pipeline. It walks the two DOM trees in lockstep (evaluate / compare / align),
 * reconstructing div-based grid → cell structure from `fx`, so grids are handled
 * from real layout rather than guessed from gaps.
 *
 * Where it stands (measured against the guillotine on the same fixture):
 *  - Stack edits, 2-col splits, checklists, add/remove within a row: 0px.
 *  - The asymmetric-gap grid-list it aligns to ~3px where the guillotine leaves
 *    ~179px (its clear win — no fragile geometric grid detection).
 *  - Grid row-height GROWS (a card body reflowing taller) still leave ~20–30px:
 *    a one-shot pass can't know the post-reflow stretched height without
 *    measuring, so these need the iterative corrective. Insert-at-top leaves
 *    ~1px after one corrective round.
 *
 * Conclusion of the evaluation: neither a one-shot recursive walk nor a
 * corrective-only loop beats `spacingPlan` + the iterative corrective on the full
 * chaos harness — the structural pass gives the loop a good seed and the loop
 * measures away the reflow it can't predict. This test pins what the recursive
 * aligner already does so it can be hardened toward parity.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { COLLECT_MARKERS_JS, type MarkerDoc } from "@/lib/compare/markers";
import { matchedYDelta } from "@/lib/compare/layout";
import { alignForest } from "@/lib/compare/treeAlign";
import { INJECT_SPACERS } from "@/lib/compare/inject";

const base = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/align/base.html",
  ),
  "utf8",
);

let browser: Browser;
beforeAll(async () => {
  browser = await (
    await import("playwright")
  ).chromium.launch({ chromiumSandbox: false });
});
afterAll(async () => browser?.close());
const collect = (p: Page) =>
  p.evaluate(COLLECT_MARKERS_JS) as Promise<MarkerDoc>;

/** Structural residual with the recursive tree aligner (no corrective). */
const residual = async (mutate: () => void): Promise<number> => {
  const before = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const after = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await before.setContent(base);
    await after.setContent(base);
    await after.evaluate(mutate);
    const [mb, ma] = await Promise.all([collect(before), collect(after)]);
    const plan = alignForest(mb.m, ma.m);
    await before.evaluate(INJECT_SPACERS, plan.a as never);
    await after.evaluate(INJECT_SPACERS, plan.b as never);
    const [ab, aa] = await Promise.all([collect(before), collect(after)]);
    return Math.abs(matchedYDelta(ab.m, aa.m).max);
  } finally {
    await Promise.all([before.close(), after.close()]);
  }
};

// Cases the recursive aligner resolves cleanly (structural, no corrective).
const cases: Array<{ name: string; max: number; mutate: () => void }> = [
  {
    name: "reword a post (stack)",
    max: 4,
    mutate: () => {
      (
        document.querySelectorAll(".post .swiss-body")[0] as HTMLElement
      ).textContent = "Short.";
    },
  },
  {
    name: "grow the hero (full-page stack shift)",
    max: 4,
    mutate: () => {
      (
        document.querySelector("#hero .swiss-body-lg") as HTMLElement
      ).textContent =
        "A much longer hero paragraph that wraps across several lines and pushes the rest of the page down.";
    },
  },
  {
    name: "reword the prose side of a 2-col split",
    max: 6,
    mutate: () => {
      (
        document.querySelector(
          "#architecture .two > div .swiss-body-lg",
        ) as HTMLElement
      ).textContent =
        "Not a per-seat SaaS but a physical AI node you own outright, so the prose column grows taller than the checklist beside it.";
    },
  },
  {
    name: "lengthen a checklist item (flex LI)",
    max: 6,
    mutate: () => {
      (
        document.querySelectorAll(
          "#architecture .checklist li .swiss-body",
        )[1] as HTMLElement
      ).textContent =
        "Autonomous agent orchestration with sandboxed execution, permissions, and clear human-in-the-loop triggers so nothing runs unattended.";
    },
  },
  {
    name: "reword an asymmetric-gap grid-list item (guillotine's weak spot)",
    max: 8,
    mutate: () => {
      (
        document.querySelectorAll(
          "#compounding .gridlist li .swiss-body",
        )[2] as HTMLElement
      ).textContent =
        "Workflows captured once run the same way every time after, and the record of why stays searchable for the whole team.";
    },
  },
  {
    name: "remove a row-2 grid card (filler cell)",
    max: 6,
    mutate: () => {
      document.querySelectorAll(".dept")[4].remove();
    },
  },
];

describe("recursive tree aligner (WIP alternative)", () => {
  for (const c of cases) {
    it(`${c.name} → aligns`, async () => {
      const r = await residual(c.mutate);
      if (r > c.max) console.warn(`[treeAlign:${c.name}] residual ${r}px`);
      expect(r).toBeLessThanOrEqual(c.max);
    }, 30_000);
  }

  // Documented gaps (grid row-height grows, insert-at-top) — one-shot can't
  // predict post-reflow stretched heights; they need the iterative corrective.
  // Pinned loosely so improvement is visible; tighten as the aligner is hardened.
  const wip: Array<{ name: string; max: number; mutate: () => void }> = [
    {
      name: "grow a dept card (2-row grid) [WIP → needs corrective]",
      max: 40,
      mutate: () => {
        (
          document.querySelectorAll(".dept .swiss-body")[1] as HTMLElement
        ).textContent =
          "Monitors markets, digests research, scans competitors, benchmarks pricing, and produces briefed intelligence rather than raw dumps.";
      },
    },
    {
      name: "insert a post at the top [WIP → ~1px after corrective]",
      max: 160,
      mutate: () => {
        document
          .querySelector(".posts")!
          .insertAdjacentHTML(
            "afterbegin",
            '<li class="post"><p class="date">Jul 19</p><h3 class="swiss-heading-md">New</h3><p class="swiss-body">Body here now.</p></li>',
          );
      },
    },
  ];
  for (const c of wip) {
    it(`${c.name}`, async () => {
      const r = await residual(c.mutate);
      expect(r).toBeLessThanOrEqual(c.max);
    }, 30_000);
  }
});
