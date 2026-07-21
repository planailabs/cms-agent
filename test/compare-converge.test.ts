import { describe, expect, it } from "vitest";
import {
  runCorrectiveAlignment,
  type CorrectiveAlignmentResult,
} from "@/lib/compare/converge";
import type { MarkerDoc } from "@/lib/compare/markers";
import {
  correctiveTrusted,
  matchedYDelta,
  type SpacingPlan,
} from "@/lib/compare/layout";
import fullRewrite from "./fixtures/full-rewrite-markers.json" with { type: "json" };

const doc = (y: number): MarkerDoc => ({
  h: 500,
  m: [{ k: "P:same content#1", y, x: 0, w: 100, h: 20, i: 1 }],
});

const shift = (source: MarkerDoc, spacers: SpacingPlan["a"]): MarkerDoc => ({
  ...source,
  m: source.m.map((m) => ({
    ...m,
    y: m.y + spacers.filter((s) => s.i === m.i).reduce((n, s) => n + s.px, 0),
  })),
});

const converge = async (
  options: Parameters<typeof runCorrectiveAlignment>[3] = {},
): Promise<{ result: CorrectiveAlignmentResult; calls: number }> => {
  let calls = 0;
  const result = await runCorrectiveAlignment(
    doc(100),
    doc(0),
    async (plan) => {
      calls++;
      return [shift(doc(100), plan.a), shift(doc(0), plan.b)];
    },
    options,
  );
  return { result, calls };
};

describe("runCorrectiveAlignment", () => {
  it("stops once the measured residual reaches the threshold", async () => {
    let a = doc(100);
    let b = doc(0);
    let calls = 0;
    const result = await runCorrectiveAlignment(
      a,
      b,
      async (plan) => {
        calls++;
        a = shift(a, plan.a);
        b = shift(b, plan.b);
        return [a, b];
      },
      { threshold: 2 },
    );

    expect(calls).toBeGreaterThan(0);
    expect(result.rounds).toBe(calls);
    expect(Math.abs(result.end.max)).toBeLessThanOrEqual(2);
    expect(result.aborted).toBe(false);
    expect(result.regressed).toBe(false);
  });

  it("skips corrective mutations when confidence disables them", async () => {
    const { result, calls } = await converge({ enabled: false });
    expect(calls).toBe(0);
    expect(result.start).toBe(100);
    expect(result.end.max).toBe(100);
  });

  it("aborts a stale run immediately after an in-flight mutation", async () => {
    let current = true;
    const result = await runCorrectiveAlignment(
      doc(100),
      doc(0),
      async (plan) => {
        current = false;
        return [shift(doc(100), plan.a), shift(doc(0), plan.b)];
      },
      { isCurrent: () => current },
    );

    expect(result.rounds).toBe(1);
    expect(result.aborted).toBe(true);
  });

  it("stops immediately when an additive round worsens drift", async () => {
    const result = await runCorrectiveAlignment(
      doc(100),
      doc(0),
      async () => [doc(100), doc(-250)],
      { threshold: 8 },
    );

    expect(result.rounds).toBe(1);
    expect(result.regressed).toBe(true);
    expect(Math.abs(result.end.max)).toBeGreaterThan(Math.abs(result.start));
  });

  it("ignores untrusted structural matches in conservative mode", async () => {
    const a: MarkerDoc = {
      h: 500,
      m: [{ k: "H2:Old title#1", y: 100, i: 1, sid: "hero", c: "title" }],
    };
    const b: MarkerDoc = {
      h: 500,
      m: [{ k: "H2:New title#1", y: 0, i: 1, sid: "hero", c: "title" }],
    };
    let calls = 0;
    const result = await runCorrectiveAlignment(
      a,
      b,
      async () => {
        calls++;
        return [a, b];
      },
      { trustedOnly: true },
    );

    expect(calls).toBe(0);
    expect(result.start).toBe(0);
  });
});

describe("trusted correction", () => {
  it("moves every grid item in a row but counts its downstream shift once", () => {
    const marker = (k: string, y: number, i: number) => ({
      k: `H3:${k}#1`,
      y,
      i,
      fx: "DIV/3#1",
    });
    const a = [
      marker("Command", 100, 1),
      marker("Analysis", 100, 2),
      marker("Growth", 200, 3),
      marker("Build", 200, 4),
    ];
    const b = [
      marker("Command", 0, 11),
      marker("Analysis", 0, 12),
      marker("Growth", 100, 13),
      marker("Build", 100, 14),
    ];

    expect(correctiveTrusted(a, b)).toEqual({
      a: [],
      b: [
        { i: 11, px: 70, mode: "item" },
        { i: 12, px: 70, mode: "item" },
        { i: 13, px: 21, mode: "item" },
        { i: 14, px: 21, mode: "item" },
      ],
    });
  });

  it("keeps the production full-rewrite correction sparse and bounded", () => {
    const a = fullRewrite.before as MarkerDoc;
    const b = fullRewrite.after as MarkerDoc;
    const plan = correctiveTrusted(a.m, b.m);
    const spacers = [...plan.a, ...plan.b];

    expect(spacers).toHaveLength(9);
    expect(Math.max(...spacers.map((s) => s.px))).toBeLessThan(200);
    expect(matchedYDelta(a.m, b.m, true).worst).toHaveLength(8);
  });
});
