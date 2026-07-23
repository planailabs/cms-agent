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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Headless chromium in the nix/container env — skip host-lib validation.
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { COLLECT_MARKERS_JS, type MarkerDoc } from "@/lib/compare/markers";
import {
  buildLayout,
  boxDiff,
  spacingPlan,
  matchedYDelta,
} from "@/lib/compare/layout";
import {
  ALIGN_CORRECTIVE_THRESHOLD,
  runCorrectiveAlignment,
} from "@/lib/compare/converge";
import {
  INJECT_SPACERS,
  PROBE_SPACER_OWNERS,
} from "@/lib/compare/inject";

const base = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/align/base.html",
  ),
  "utf8",
);

let browser: Browser;
beforeAll(async () => {
  const pw = await import("playwright");
  browser = await pw.chromium.launch({ chromiumSandbox: false });
});
afterAll(async () => browser?.close());

const collect = (p: Page) =>
  p.evaluate(COLLECT_MARKERS_JS) as Promise<MarkerDoc>;

/** Run the full pipeline for base vs base+mutate; return residual y drift.
 *  `mutate` runs in the browser; `arg` (JSON-serialisable) is passed to it. */
const residual = async (
  mutate: (arg?: unknown) => void,
  arg?: unknown,
): Promise<{ max: number; worst: unknown }> => {
  const before = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const after = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
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

/** Structural plan + the LAST-RESORT corrective pass, as the real pipeline runs
 *  it: inject → re-collect → corrective-inject → re-collect. Returns final drift. */
const residualCorrected = async (
  mutate: (arg?: unknown) => void,
  arg?: unknown,
  options: Parameters<typeof runCorrectiveAlignment>[3] = {},
): Promise<number> => {
  const before = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const after = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await before.setContent(base);
    await after.setContent(base);
    await after.evaluate(mutate, arg);
    const [mb, ma] = await Promise.all([collect(before), collect(after)]);
    const plan = spacingPlan(mb.m, mb.h, ma.m, ma.h);
    await before.evaluate(INJECT_SPACERS, plan.a as never);
    await after.evaluate(INJECT_SPACERS, plan.b as never);
    const [ab, aa] = await Promise.all([collect(before), collect(after)]);
    const aligned = await runCorrectiveAlignment(
      ab,
      aa,
      async (corr) => {
        await Promise.all([
          before.evaluate(INJECT_SPACERS, corr.a as never),
          after.evaluate(INJECT_SPACERS, corr.b as never),
        ]);
        return await Promise.all([collect(before), collect(after)]);
      },
      {
        ...options,
        refinePlan: async (candidate) => {
          const [a, b] = await Promise.all([
            before.evaluate(PROBE_SPACER_OWNERS, candidate.a),
            after.evaluate(PROBE_SPACER_OWNERS, candidate.b),
          ]);
          return { a: a as never, b: b as never };
        },
      },
    );
    // Screenshot/live callers discard a regressed additive round and retain the
    // structural seed, so model that transaction boundary here as well.
    return Math.abs(aligned.regressed ? aligned.start : aligned.end.max);
  } finally {
    await Promise.all([before.close(), after.close()]);
  }
};

// Each mutation runs IN THE BROWSER (no closures over Node scope).
const cases: Array<{ name: string; mutate: () => void; max: number }> = [
  {
    name: "reword a post body",
    max: 4,
    mutate: () => {
      (
        document.querySelectorAll(".post .swiss-body")[0] as HTMLElement
      ).textContent =
        "A completely rewritten body for this first post, a little longer than before.";
    },
  },
  {
    name: "insert a post at the top",
    max: 4,
    mutate: () => {
      document
        .querySelector(".posts")!
        .insertAdjacentHTML(
          "afterbegin",
          '<li class="post"><p class="date">Jul 19, 2026</p><h3 class="swiss-heading-md">What Squirrels Know</h3><p class="swiss-body">Good ideas rarely arrive fully formed; collect the small promising things.</p></li>',
        );
    },
  },
  {
    name: "remove a middle post",
    max: 4,
    mutate: () => {
      document.querySelectorAll(".post")[1].remove();
    },
  },
  {
    name: "grow the hero paragraph",
    max: 4,
    mutate: () => {
      (
        document.querySelector("#hero .swiss-body-lg") as HTMLElement
      ).textContent =
        "A much longer hero paragraph that now wraps across several lines and pushes everything below it down by a meaningful amount, testing full-page vertical realignment end to end.";
    },
  },
  {
    name: "insert a whole new section",
    max: 4,
    mutate: () => {
      document
        .querySelector("#journal")!
        .insertAdjacentHTML(
          "beforebegin",
          '<section id="quotes"><h2 class="swiss-heading-lg">In their words</h2><p class="swiss-body">A brand new section inserted between features and journal.</p></section>',
        );
    },
  },
  {
    name: "remove a grid card",
    max: 6,
    mutate: () => {
      document.querySelectorAll(".card")[1].remove();
    },
  },
  {
    name: "change nested card heading",
    max: 4,
    mutate: () => {
      (document.querySelectorAll(".card h3")[1] as HTMLElement).textContent =
        "Insight";
    },
  },
  {
    name: "add a table row",
    max: 4,
    mutate: () => {
      document
        .querySelector("table")!
        .insertAdjacentHTML(
          "beforeend",
          "<tr><td>Comments</td><td>50</td><td>210</td></tr>",
        );
    },
  },
  {
    name: "change a table cell",
    max: 4,
    mutate: () => {
      (document.querySelectorAll("td")[1] as HTMLElement).textContent = "9,999";
    },
  },
  {
    name: "grow a department card (grid row height)",
    max: 6,
    mutate: () => {
      // Lengthen ONE row-1 card's body → its whole grid row grows taller, pushing
      // row 2 (Growth/Build/Process) down together. Command must stay aligned with
      // its row and row 2 must move as a unit, not per-column.
      (
        document.querySelectorAll(".dept .swiss-body")[1] as HTMLElement
      ).textContent =
        "Monitors markets, digests research, scans competitors, benchmarks pricing, tracks sentiment, and produces briefed intelligence rather than raw data dumps that nobody has time to read.";
    },
  },
  {
    name: "remove a department card (row 2, filler cell)",
    max: 6,
    mutate: () => {
      // Remove a row-2 card: later cards in that row shift left; a filler grid cell
      // keeps them in place. No card crosses a row boundary.
      document.querySelectorAll(".dept")[4].remove();
    },
  },
  {
    name: "card headings wrap to different line counts (silicon shift)",
    max: 6,
    mutate: () => {
      // The real cms-server regression: two of the three cards' headings become
      // 2-line, and every body changes height. The tallest card is NOT the first,
      // so growing only the first card leaves the row (and all content below) off.
      const f = document.querySelectorAll(".force");
      (f[0].querySelector("h4") as HTMLElement).textContent =
        "Local compute is ready.";
      (f[0].querySelector(".swiss-body") as HTMLElement).textContent =
        "Current desktop-class systems can run capable models on-device with low latency.";
      (f[1].querySelector("h4") as HTMLElement).textContent =
        "Governance is becoming operational and mandatory.";
      (f[1].querySelector(".swiss-body") as HTMLElement).textContent =
        "As AI enters everyday workflows, documented oversight and provenance become table stakes for regulated teams everywhere.";
      (f[2].querySelector("h4") as HTMLElement).textContent =
        "The seat is no longer the unit of value.";
      (f[2].querySelector(".swiss-body") as HTMLElement).textContent =
        "AI agents work across tools and functions, so the durable advantage comes from owning the workflows.";
    },
  },
  {
    name: "grow an inline-block column (no flex/grid)",
    max: 6,
    mutate: () => {
      // A plain inline-block column row: no stretch coupling, so growing one column
      // only pushes the content BELOW the row down by the new tallest height. The
      // filler must land as a flow div (not margin-top / not a grid tail).
      (
        document.querySelectorAll(".col .swiss-body")[0] as HTMLElement
      ).textContent =
        "A short inline-block column that has now been expanded with a good deal more text so that it wraps onto several lines and becomes the tallest column in this row by a clear margin.";
    },
  },
  {
    name: "grow a 4-col card body (DIV/4 row)",
    max: 6,
    mutate: () => {
      (
        document.querySelectorAll(
          "#environments .cell .swiss-body",
        )[2] as HTMLElement
      ).textContent =
        "Compact units placed close to where the work and the data already live, sized to slot into an existing rack and quiet enough to run beside a desk without any special handling at all.";
    },
  },
  {
    name: "wrap a 4-col card heading (DIV/4)",
    max: 6,
    mutate: () => {
      (
        document.querySelectorAll("#environments .cell h4")[1] as HTMLElement
      ).textContent = "Colocation and managed facilities";
    },
  },
  {
    name: "reword the prose side of a 2-col split (DIV/2)",
    max: 6,
    mutate: () => {
      (
        document.querySelector(
          "#architecture .two > div .swiss-body-lg",
        ) as HTMLElement
      ).textContent =
        "Not a per-seat SaaS but a physical AI node you own outright, provisioned for your organisation and yours to keep, so the prose column grows taller than the checklist beside it.";
    },
  },
  {
    name: "lengthen a checklist item (flex LI + P)",
    max: 6,
    mutate: () => {
      (
        document.querySelectorAll(
          "#architecture .checklist li .swiss-body",
        )[1] as HTMLElement
      ).textContent =
        "Autonomous agent orchestration with sandboxed execution, permissions, and clear human-in-the-loop triggers so nothing runs unattended without an explicit, auditable approval step.";
    },
  },
  {
    name: "reword a grid-list item (UL as 2-col grid)",
    max: 6,
    mutate: () => {
      (
        document.querySelectorAll(
          "#compounding .gridlist li .swiss-body",
        )[0] as HTMLElement
      ).textContent =
        "Every approved source makes the next answer sharper, and the improvement compounds quietly in the background across every department that touches the node.";
    },
  },
  {
    name: "change a stat number (DIV/4 of P)",
    max: 4,
    mutate: () => {
      (
        document.querySelectorAll("#compounding .stat")[1] as HTMLElement
      ).textContent = "5×";
    },
  },
  {
    name: "lengthen an FAQ answer (stacked Q/A)",
    max: 4,
    mutate: () => {
      (document.querySelectorAll("#faq p.a")[0] as HTMLElement).textContent =
        "No. The node is telemetry-minimal by design and stays off the public internet by default; diagnostics, if ever enabled, are opt-in and strictly local to the machine you control.";
    },
  },
  {
    name: "multiple simultaneous edits",
    max: 6,
    mutate: () => {
      document
        .querySelector(".posts")!
        .insertAdjacentHTML(
          "afterbegin",
          '<li class="post"><p class="date">Jul 19, 2026</p><h3 class="swiss-heading-md">What Squirrels Know</h3><p class="swiss-body">Collect the small promising things.</p></li>',
        );
      (document.querySelectorAll("td")[3] as HTMLElement).textContent = "42";
      (
        document.querySelector("#hero .swiss-body-lg") as HTMLElement
      ).textContent =
        "A longer hero paragraph that wraps to a second line here.";
    },
  },
];

describe("real-browser alignment", () => {
  it("inserting a repeated post creates a before-side filler", async () => {
    const before = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const after = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await before.setContent(base);
      await after.setContent(base);
      await after.evaluate(() => {
        document.querySelector(".posts")!.insertAdjacentHTML(
          "afterbegin",
          '<li class="post"><p class="date">Jul 19, 2026</p><h3 class="swiss-heading-md">What Squirrels Know</h3><p class="swiss-body">Good ideas rarely arrive fully formed; collect the small promising things.</p></li>',
        );
      });
      const [mb, ma] = await Promise.all([collect(before), collect(after)]);
      const layout = buildLayout(mb.m, mb.h, ma.m, ma.h)!;
      const segments = (node: typeof layout): NonNullable<typeof layout.segs> =>
        node.segs ?? node.children?.flatMap(segments) ?? [];
      expect(segments(layout).some((s) => s.hB - s.hA >= 80)).toBe(true);

      const plan = spacingPlan(mb.m, mb.h, ma.m, ma.h);
      expect(plan.a.reduce((sum, spacer) => sum + spacer.px, 0)).toBeGreaterThanOrEqual(80);
    } finally {
      await Promise.all([before.close(), after.close()]);
    }
  }, 30_000);

  for (const c of cases) {
    it(`${c.name} → matched content aligns`, async () => {
      const r = await residual(c.mutate);
      if (r.max > c.max)
        console.warn(
          `[align:${c.name}] residual ${r.max}px`,
          JSON.stringify(r.worst),
        );
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

interface Op {
  kind: string;
  n?: number;
  text?: string;
}
const LOREM =
  "the small promising things collect momentum clarity and care across every function and channel over time";
const words = (r: () => number, min: number, max: number): string => {
  const parts = LOREM.split(" ");
  const count = min + Math.floor(r() * (max - min));
  let s = "";
  for (let i = 0; i < count; i++)
    s += parts[Math.floor(r() * parts.length)] + " ";
  return s.trim() + ".";
};

const OP_KINDS = [
  "rewordPost",
  "insertPost",
  "removePost",
  "growHero",
  "rewordDept",
  "removeDeptRow2",
  "growCol",
  "addTableRow",
  "changeCell",
  // random text changes across every imported plan.ai pattern
  "rewordForce", // 3-col cards (inflection)
  "rewordEnv", // 4-col cards (environments)
  "wrapEnvHead", // 4-col card heading
  "rewordSplit", // 2-col split prose (architecture)
  "rewordCheck", // checklist flex LI
  "rewordGrid", // grid-list item (compounding)
  "changeStat", // stat number
  "rewordFaq", // FAQ answer
  "rewordFeature", // single-row 3-col grid (features)
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
const applyOps = (
  ops: Array<{ kind: string; n?: number; text?: string }>,
): void => {
  const at = (sel: string, i: number) =>
    document.querySelectorAll(sel)[i] as HTMLElement | undefined;
  for (const op of ops) {
    const i = op.n ?? 0;
    const t = op.text ?? "Changed.";
    if (op.kind === "rewordPost") {
      const e = at(".post .swiss-body", i);
      if (e) e.textContent = t;
    } else if (op.kind === "insertPost")
      document
        .querySelector(".posts")
        ?.insertAdjacentHTML(
          "afterbegin",
          `<li class="post"><p class="date">Jul 19, 2026</p><h3 class="swiss-heading-md">New Note</h3><p class="swiss-body">${t}</p></li>`,
        );
    else if (op.kind === "removePost") at(".post", i)?.remove();
    else if (op.kind === "growHero") {
      const e = document.querySelector(
        "#hero .swiss-body-lg",
      ) as HTMLElement | null;
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "rewordDept") {
      const e = at(".dept .swiss-body", i);
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "removeDeptRow2")
      at(".dept", 3 + i)?.remove(); // rows 2 only (indices 3..5)
    else if (op.kind === "growCol") {
      const e = at(".col .swiss-body", i);
      if (e) e.textContent = t + " " + t + " " + t;
    } else if (op.kind === "addTableRow")
      document
        .querySelector("table")
        ?.insertAdjacentHTML(
          "beforeend",
          `<tr><td>Row</td><td>${i}</td><td>${t.slice(0, 8)}</td></tr>`,
        );
    else if (op.kind === "changeCell") {
      const e = at("td", i);
      if (e) e.textContent = t.slice(0, 6);
    } else if (op.kind === "rewordForce") {
      const e = at("#inflection .force .swiss-body", i);
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "rewordEnv") {
      const e = at("#environments .cell .swiss-body", i % 4);
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "wrapEnvHead") {
      const e = at("#environments .cell h4", i % 4);
      if (e) e.textContent = t.slice(0, 30);
    } else if (op.kind === "rewordSplit") {
      const e = document.querySelector(
        "#architecture .two > div .swiss-body-lg",
      ) as HTMLElement | null;
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "rewordCheck") {
      const e = at("#architecture .checklist li .swiss-body", i % 4);
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "rewordGrid") {
      const e = at("#compounding .gridlist li .swiss-body", i % 4);
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "changeStat") {
      const e = at("#compounding .stat", i % 4);
      if (e) e.textContent = String(2 + i) + "×";
    } else if (op.kind === "rewordFaq") {
      const e = at("#faq p.a", i % 3);
      if (e) e.textContent = t + " " + t;
    } else if (op.kind === "rewordFeature") {
      const e = at("#features .card .swiss-body", i % 3);
      if (e) e.textContent = t + " " + t;
    }
  }
};

/** Exercise every property exposed by getComputedStyle on random visible
 * leaves. Values come from another real element; uniform properties use the
 * universally valid `initial` value so the property is still covered. */
const applyComputedStyleChaos = (seed: number): void => {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(
      "h1,h2,h3,h4,p,li,span,td,th,a,strong",
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const snapshots = elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      element,
      values: new Map(
        Array.from(style, (property) => [
          property,
          style.getPropertyValue(property),
        ]),
      ),
    };
  });
  const properties = [
    ...new Set(snapshots.flatMap(({ values }) => [...values.keys()])),
  ].sort();
  let state = seed | 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  for (const property of properties) {
    const target = snapshots[Math.floor(random() * snapshots.length)];
    const original = target.values.get(property);
    const alternatives = snapshots.filter(
      ({ values }) => values.get(property) !== original,
    );
    const source = alternatives[Math.floor(random() * alternatives.length)];
    target.element.style.setProperty(
      property,
      source?.values.get(property) || "initial",
      "important",
    );
  }
  document.documentElement.dataset.styleChaosProperties = String(
    properties.length,
  );
};

// The last-resort corrective pass patches leftover FLOW drift and must never
// make a case worse (grid/flex cells are left to the structural pass).
describe("real-browser alignment — last-resort corrective", () => {
  it("keeps already-aligned content aligned (idempotent, safe)", async () => {
    // A mix that the structural pass already handles: the corrective must not
    // disturb it.
    const mutate = () => {
      (
        document.querySelector("#hero .swiss-body-lg") as HTMLElement
      ).textContent =
        "A longer hero paragraph that wraps to a couple of lines here for good measure.";
      (
        document.querySelectorAll(".post .swiss-body")[0] as HTMLElement
      ).textContent = "Rewritten.";
    };
    const r = await residualCorrected(mutate as never);
    expect(r).toBeLessThanOrEqual(ALIGN_CORRECTIVE_THRESHOLD);
  }, 30_000);

  it("never worsens a case the structural pass cannot fully solve", async () => {
    // Cross-row grid removal: a row-2 card pulls up into row 1 (the documented
    // 2-D limitation). The corrective skips the coupled grid cell, so the result
    // is no worse than structural-only — and any flow drift below is patched.
    const mutate = () => document.querySelectorAll(".dept")[1].remove();
    const structural = (await residual(mutate as never)).max;
    const corrected = await residualCorrected(mutate as never);
    expect(corrected).toBeLessThanOrEqual(structural + 2);
  }, 30_000);
});

// Chaos runs the FULL production pipeline (structural plan + iterative
// corrective) and asserts it converges — arbitrary combinations of edits across
// every imported plan.ai pattern must end up aligned.
describe("real-browser alignment — chaos", () => {
  for (let seed = 1; seed <= 16; seed++) {
    it(`seed ${seed} → matched content aligns`, async () => {
      const ops = buildOps(seed);
      const r = await residualCorrected(applyOps as never, ops);
      if (r > ALIGN_CORRECTIVE_THRESHOLD)
        console.warn(
          `[chaos:${seed}] residual ${r}px ops=${JSON.stringify(ops)}`,
        );
      expect(r).toBeLessThanOrEqual(ALIGN_CORRECTIVE_THRESHOLD);
    }, 30_000);
  }
});

describe("real-browser alignment — computed-style chaos", () => {
  for (const seed of [101, 202, 303]) {
    it(`seed ${seed} covers every computed property`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      try {
        await page.setContent(base);
        const expected = await page.evaluate(
          () => Array.from(getComputedStyle(document.body)).length,
        );
        await page.evaluate(applyComputedStyleChaos, seed);
        const covered = await page.evaluate(
          () => Number(document.documentElement.dataset.styleChaosProperties),
        );
        expect(covered).toBe(expected);
        expect(covered).toBeGreaterThan(300);
      } finally {
        await page.close();
      }

      const drift = await residualCorrected(
        applyComputedStyleChaos as never,
        seed,
      );
      if (drift > ALIGN_CORRECTIVE_THRESHOLD)
        console.warn(`[style-chaos:${seed}] residual ${drift}px`);
      expect(drift).toBeLessThanOrEqual(ALIGN_CORRECTIVE_THRESHOLD);
    }, 60_000);
  }
});

describe("measured spacer owners", () => {
  it("solves measured forward dependencies without double-counting", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`
        <main style="display:flex; flex-direction:column">
          <p>First target</p>
          <p>Second target</p>
        </main>
      `);
      const markers = await collect(page);
      const first = markers.m.find((marker) => marker.k.startsWith("P:First"))!;
      const second = markers.m.find((marker) => marker.k.startsWith("P:Second"))!;
      const refined = await page.evaluate(PROBE_SPACER_OWNERS, [
        { i: first.i!, px: 20.5, mode: "el" },
        { i: second.i!, px: 30.25, mode: "el" },
      ]);

      expect(refined.map((spacer) => spacer.px)).toEqual([20.5, 9.75]);
      await page.evaluate(INJECT_SPACERS, refined);
      const after = await collect(page);
      expect(
        after.m.find((marker) => marker.i === first.i)!.y - first.y,
      ).toBe(20.5);
      expect(
        after.m.find((marker) => marker.i === second.i)!.y - second.y,
      ).toBe(30.25);
    } finally {
      await page.close();
    }
  });

  it("probes ancestors and collapses one table row to one owner", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await page.setContent(base);
      const markers = await collect(page);
      const cells = markers.m.filter(
        (marker) =>
          marker.k.startsWith("TD:") &&
          ["#r1c0", "#r1c1", "#r1c2"].some((cell) =>
            marker.fx?.endsWith(cell),
          ),
      );
      const target = cells[0];
      const top = (id: number | undefined) =>
        page.evaluate(
          (markerId) =>
            document
              .querySelector(`[data-cmsm="${markerId}"]`)!
              .getBoundingClientRect().top,
          id,
        );
      const before = await top(target.i);
      const refined = await page.evaluate(
        PROBE_SPACER_OWNERS,
        cells.map((cell) => ({ i: cell.i!, px: 24, mode: "el" })),
      );
      expect(refined).toHaveLength(1);
      expect(refined[0].mode).toBe("owner");
      await page.evaluate(INJECT_SPACERS, refined);
      expect(Math.abs((await top(target.i)) - before - 24)).toBeLessThanOrEqual(
        1,
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("measures inside-padding instead of trusting a scope id", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(base);
      const markers = await collect(page);
      const target = markers.m.find((marker) =>
        marker.k.startsWith("H3:One machine"),
      )!;
      const before = target.y;
      const refined = await page.evaluate(PROBE_SPACER_OWNERS, [
        { i: target.i!, px: 24, mode: "scope", sid: "wrong-id" },
      ]);
      expect(refined).toMatchObject([
        { mode: "owner", action: "inside", px: 24 },
      ]);
      await page.evaluate(INJECT_SPACERS, refined);
      const after = await collect(page);
      expect(after.m.find((marker) => marker.i === target.i)!.y - before).toBe(
        24,
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("measures and moves a complete visual row", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(base);
      const markers = await collect(page);
      const row = ["Command", "Analysis", "Voice"].map(
        (title) =>
          markers.m.find((marker) =>
            marker.k.startsWith(`H3:${title}`),
          )!,
      );
      const refined = await page.evaluate(PROBE_SPACER_OWNERS, [
        { i: row[0].i!, px: 24, mode: "row" },
      ]);
      expect(refined).toMatchObject([
        { mode: "owner", action: "row", px: 24 },
      ]);
      await page.evaluate(INJECT_SPACERS, refined);
      const after = await collect(page);
      for (const marker of row)
        expect(
          after.m.find((candidate) => candidate.i === marker.i)!.y - marker.y,
        ).toBe(24);
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("visual marker collection", () => {
  it("keeps an unpainted section label with its section after an insertion", async () => {
    const before = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const after = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const html = `
      <style>
        * { box-sizing: border-box }
        body { margin: 0 }
        section { padding: 80px }
        .section-eyebrow { margin-bottom: 24px }
        .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px }
        .card { min-height: 160px; border: 1px solid #333; padding: 24px }
      </style>
      <section><h1>Embedded systems</h1><p>Hardware and firmware engineering.</p></section>
      <section id="capabilities">
        <div class="section-head">
          <div class="section-eyebrow">// Capabilities</div>
          <h2>What we build</h2>
          <p>End-to-end delivery across embedded hardware and firmware.</p>
        </div>
        <div class="cards">
          <div class="card"><h3>Firmware</h3><p>Bare-metal and RTOS systems.</p></div>
          <div class="card"><h3>Hardware</h3><p>PCB and schematic design.</p></div>
        </div>
      </section>
      <section><h2>Selected work</h2><p>Medical and industrial systems.</p></section>
    `;
    try {
      await Promise.all([before.setContent(html), after.setContent(html)]);
      await after.evaluate(() => {
        document.querySelector("#capabilities")!.insertAdjacentHTML(
          "beforebegin",
          `<section>
            <h2>Preview change review</h2>
            <p>This added section should create a filler on the other side.</p>
            <div class="cards">
              <div class="card"><h3>Visible markers</h3><p>Added and ready.</p></div>
              <div class="card"><h3>Status checklist</h3><p>Ready to review.</p></div>
            </div>
          </section>`,
        );
      });
      const [mb, ma] = await Promise.all([collect(before), collect(after)]);
      const plan = spacingPlan(mb.m, mb.h, ma.m, ma.h);
      await Promise.all([
        before.evaluate(INJECT_SPACERS, plan.a as never),
        after.evaluate(INJECT_SPACERS, plan.b as never),
      ]);
      const [ab, aa] = await Promise.all([collect(before), collect(after)]);
      await runCorrectiveAlignment(
        ab,
        aa,
        async (correction) => {
          await Promise.all([
            before.evaluate(INJECT_SPACERS, correction.a as never),
            after.evaluate(INJECT_SPACERS, correction.b as never),
          ]);
          return await Promise.all([collect(before), collect(after)]);
        },
        {
          refinePlan: async (candidate) => ({
            a: (await before.evaluate(
              PROBE_SPACER_OWNERS,
              candidate.a,
            )) as never,
            b: (await after.evaluate(
              PROBE_SPACER_OWNERS,
              candidate.b,
            )) as never,
          }),
        },
      );
      const [beforeY, afterY] = await Promise.all(
        [before, after].map((page) =>
          page.locator(".section-eyebrow").evaluate(
            (element) => element.getBoundingClientRect().top,
          ),
        ),
      );
      expect(Math.abs(beforeY - afterY)).toBeLessThanOrEqual(1);
    } finally {
      await Promise.all([before.close(), after.close()]);
    }
  }, 30_000);

  it("collects substantial painted blocks but not plain layout wrappers", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`
        <main>
          <div class="plain"><p>Ordinary content</p></div>
          <div class="diagram-frame" style="width:400px;height:300px;border:1px solid #333;background:#111">
            <svg width="200" height="100"><rect width="200" height="100" fill="#555" /></svg>
          </div>
        </main>
      `);
      const markers = await collect(page);
      expect(markers.m.some((marker) => marker.v && marker.c === "plain")).toBe(
        false,
      );
      expect(
        markers.m.some(
          (marker) => marker.v && marker.c === "diagram-frame",
        ),
      ).toBe(true);
      expect(
        markers.m.some(
          (marker) => marker.v && marker.k.toUpperCase().startsWith("V:SVG"),
        ),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("aligns a painted frame and its dependent illustration edges", async () => {
    const before = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const after = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const html = `
      <main style="display:flex;flex-direction:column">
        <p>Already aligned content</p>
        <div class="diagram-frame" style="width:400px;height:300px;border:1px solid #333;background:#111">
          <svg width="200" height="100"><rect width="200" height="100" fill="#555" /></svg>
        </div>
      </main>
    `;
    try {
      await Promise.all([before.setContent(html), after.setContent(html)]);
      await after.locator(".diagram-frame").evaluate(
        (element) => ((element as HTMLElement).style.marginTop = "30px"),
      );
      const [a, b] = await Promise.all([collect(before), collect(after)]);
      const frame = (doc: MarkerDoc) =>
        doc.m.find((marker) => marker.v && marker.c === "diagram-frame")!;
      expect(frame(b).y - frame(a).y).toBe(30);

      const aligned = await runCorrectiveAlignment(
        a,
        b,
        async (plan) => {
          await Promise.all([
            before.evaluate(INJECT_SPACERS, plan.a as never),
            after.evaluate(INJECT_SPACERS, plan.b as never),
          ]);
          return await Promise.all([collect(before), collect(after)]);
        },
        {
          refinePlan: async (candidate) => {
            const [left, right] = await Promise.all([
              before.evaluate(PROBE_SPACER_OWNERS, candidate.a),
              after.evaluate(PROBE_SPACER_OWNERS, candidate.b),
            ]);
            return { a: left as never, b: right as never };
          },
        },
      );

      expect(Math.abs(frame(aligned.a).y - frame(aligned.b).y)).toBeLessThanOrEqual(
        ALIGN_CORRECTIVE_THRESHOLD,
      );
      expect(Math.abs(aligned.end.max)).toBeLessThanOrEqual(
        ALIGN_CORRECTIVE_THRESHOLD,
      );
    } finally {
      await Promise.all([before.close(), after.close()]);
    }
  }, 30_000);

  it("ignores content hidden inside closed details", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`
        <main>
          <details><summary>Closed question</summary><p>Hidden answer</p></details>
          <details open><summary>Open question</summary><p>Visible answer</p></details>
        </main>
      `);
      const markers = await collect(page);
      expect(
        markers.m.some((marker) => marker.k.includes("Hidden answer")),
      ).toBe(false);
      expect(
        markers.m.some((marker) => marker.k.includes("Visible answer")),
      ).toBe(true);
      expect(
        markers.m.some((marker) => marker.k.includes("Closed question")),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("highlights changed questions while closed answers stay hidden", async () => {
    const before = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const after = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await before.setContent(`
        <main><section id="faq"><details><summary class="question">Can we deploy today?</summary><p>Hidden old answer</p></details></section></main>
      `);
      await after.setContent(`
        <main><section id="faq"><details><summary class="question">Can plan.ai be deployed today?</summary><p>Hidden new answer</p></details></section></main>
      `);
      const [a, b] = await Promise.all([collect(before), collect(after)]);
      expect(a.m.some((marker) => marker.k.includes("Hidden old answer"))).toBe(
        false,
      );
      expect(b.m.some((marker) => marker.k.includes("Hidden new answer"))).toBe(
        false,
      );
      expect(boxDiff(a.m, a.h, b.m, b.h)).toMatchObject([
        { kind: "changed" },
      ]);
    } finally {
      await Promise.all([before.close(), after.close()]);
    }
  });

  it("highlights changed block-span diagram labels but ignores inline spans", async () => {
    const before = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const after = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await before.setContent(`
        <main><section id="architecture"><div class="diagram">
          <span class="caption" style="display:block">Local machines<br />Private environment</span>
          <p>Keep <span class="emphasis">this inline fragment</span> together</p>
        </div></section></main>
      `);
      await after.setContent(`
        <main><section id="architecture"><div class="diagram">
          <span class="caption" style="display:block">Private environment</span>
          <p>Keep <span class="emphasis">this changed fragment</span> together</p>
        </div></section></main>
      `);
      const [a, b] = await Promise.all([collect(before), collect(after)]);
      expect(a.m.some((marker) => marker.c === "caption")).toBe(true);
      expect(a.m.find((marker) => marker.c === "caption")?.na).toBe(true);
      expect(a.m.some((marker) => marker.c === "emphasis")).toBe(false);
      const changed = boxDiff(a.m, a.h, b.m, b.h).filter(
        (box) => box.kind === "changed",
      );
      expect(changed).toHaveLength(2);
    } finally {
      await Promise.all([before.close(), after.close()]);
    }
  });
});

// Stable data-cmsm: an element's handle survives re-collection after the DOM
// changes (fillers injected, an earlier element removed) so the aligner
// re-selects the exact same element every round instead of a shifted index.
describe("stable element handles", () => {
  it("keeps a marker's id when an earlier element disappears", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await page.setContent(base);
      const before = await collect(page);
      const heroId = before.m.find((m) => m.k.startsWith("H1:"))!.i;
      const capId = before.m.find((m) => m.k.startsWith("H2:Latest"))!.i;
      // Remove an early element (shifts every following element's document
      // position) and inject a filler, then re-collect.
      await page.evaluate(() => document.querySelector("#masthead")!.remove());
      const after = await collect(page);
      // Same content elements still present, and their ids are UNCHANGED.
      expect(after.m.find((m) => m.k.startsWith("H1:"))!.i).toBe(heroId);
      expect(after.m.find((m) => m.k.startsWith("H2:Latest"))!.i).toBe(capId);
      // A brand-new element gets a fresh id beyond the existing maximum.
      const maxBefore = Math.max(...before.m.map((m) => m.i ?? 0));
      await page.evaluate(() =>
        document
          .querySelector("#hero")!
          .insertAdjacentHTML(
            "beforeend",
            '<p class="swiss-body">A newly added line.</p>',
          ),
      );
      const grown = await collect(page);
      const fresh = grown.m.find((m) =>
        m.k.startsWith("P:A newly added line"),
      )!;
      expect(fresh.i!).toBeGreaterThan(maxBefore);
    } finally {
      await page.close();
    }
  }, 30_000);
});

// Marker cap: over the budget, keep the largest-by-AREA elements, not the first
// N in document order — so a big element at the page BOTTOM survives (document-
// order truncation would silently drop the whole tail).
describe("marker cap (area priority)", () => {
  it("keeps large bottom-of-page content, drops small, surfaces trunc", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      // 900 tiny paragraphs (prefix), then 4 large blocks at the very bottom.
      const tiny = Array.from({ length: 900 }, (_, i) => `<p>t${i}</p>`).join(
        "",
      );
      const big = Array.from(
        { length: 4 },
        (_, i) => `<h1 style="height:240px">BOTTOM-BIG-${i}</h1>`,
      ).join("");
      await page.setContent(`<!doctype html><body>${tiny}${big}</body>`);
      const doc = await collect(page);
      // Capped to the budget, and truncation surfaced.
      expect(doc.m.length).toBe(800);
      expect(doc.trunc ?? 0).toBeGreaterThan(0);
      // The 4 large blocks at the BOTTOM survived (document-order truncation would
      // have kept only the first 800 tiny paragraphs and dropped these).
      const kept = doc.m.filter((m) => m.k.includes("BOTTOM-BIG")).length;
      expect(kept).toBe(4);
    } finally {
      await page.close();
    }
  }, 30_000);
});
