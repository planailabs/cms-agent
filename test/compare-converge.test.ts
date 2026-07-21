import { describe, expect, it } from "vitest";
import {
  runCorrectiveAlignment,
  type CorrectiveAlignmentResult,
} from "@/lib/compare/converge";
import type { MarkerDoc } from "@/lib/compare/markers";
import type { SpacingPlan } from "@/lib/compare/layout";

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
});
