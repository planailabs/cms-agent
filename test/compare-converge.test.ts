import { describe, expect, it } from "vitest";
import {
  ALIGN_CORRECTIVE_THRESHOLD,
  runCorrectiveAlignment,
  type CorrectiveAlignmentResult,
} from "@/lib/compare/converge";
import type { MarkerDoc } from "@/lib/compare/markers";
import {
  correctiveFooterFlows,
  correctiveItemFlows,
  correctiveRows,
  correctiveScopeLeads,
  correctiveSectionFlows,
  type SpacingPlan,
} from "@/lib/compare/layout";

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

  it("converges fractional geometry to the browser layout quantum", async () => {
    let a = doc(100.5);
    let b = doc(100);
    const result = await runCorrectiveAlignment(a, b, async (plan) => {
      a = shift(a, plan.a);
      b = shift(b, plan.b);
      return [a, b];
    });

    expect(Math.abs(result.end.max)).toBeLessThanOrEqual(
      ALIGN_CORRECTIVE_THRESHOLD,
    );
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

  it("does not jump back to landmarks after entering a local-flow phase", async () => {
    const state = (
      landmarkA: number,
      landmarkB: number,
      leafDeltas: [number, number, number],
    ): [MarkerDoc, MarkerDoc] => {
      const side = (
        landmarkY: number,
        deltas: [number, number, number],
        b = false,
      ): MarkerDoc => ({
        h: 800,
        m: [
          { k: "#SECTION/3/H3PP#1", y: landmarkY, i: b ? 110 : 100, d: 0 },
          {
            k: "H2:Section anchor#1",
            y: 150,
            i: b ? 30 : 3,
            sid: "section",
          },
          ...["Title", "Body", "Tail"].map((text, index) => ({
            k: `${index ? "P" : "H3"}:${text}#1`,
            y: 200 + index * 50 + (b ? 0 : deltas[index]),
            i: (b ? 20 : 10) + index,
            sid: "section",
            rg: "DIV/2@0:800",
            rp: 180,
            ry: 180,
            rc: 0,
          })),
        ],
      });
      return [side(landmarkA, leafDeltas), side(landmarkB, [0, 0, 0], true)];
    };
    const states = [
      state(0, 100, [100, 100, 100]),
      state(100, 100, [100, 100, 100]),
      state(150, 100, [-30, 0, 30]),
      state(150, 100, [0, 0, 0]),
    ];
    const plans: SpacingPlan[] = [];
    const result = await runCorrectiveAlignment(
      states[0][0],
      states[0][1],
      async (plan) => {
        plans.push(plan);
        return states[plans.length];
      },
      { trustedOnly: true, maxRounds: 3 },
    );

    expect(plans).toHaveLength(3);
    expect(plans[0].a.some((spacer) => spacer.i === 100)).toBe(true);
    expect(plans[1].b.some((spacer) => spacer.mode === "row")).toBe(true);
    expect(
      [...plans[2].a, ...plans[2].b].some(
        (spacer) => spacer.i === 100 || spacer.i === 110,
      ),
    ).toBe(false);
    expect(result.regressed).toBe(false);
  });
});

describe("trusted correction", () => {
  it("moves a scoped section's contents from its first visible anchor", () => {
    const a = [
      { k: "H2:Architecture#1", y: 135, i: 1, sid: "architecture", sy: 100 },
      { k: "P:Body#1", y: 200, i: 2, sid: "architecture", sy: 100 },
    ];
    const b = [
      { k: "H2:Architecture#1", y: 100, i: 11, sid: "architecture", sy: 100 },
      { k: "P:Body#1", y: 165, i: 12, sid: "architecture", sy: 100 },
    ];

    expect(correctiveScopeLeads(a, b)).toEqual({
      a: [],
      b: [{ i: 11, px: 35, mode: "scope", sid: "architecture" }],
    });
  });

  it("lets the row pass correct the first visible anchor inside an item", () => {
    const marker = (k: string, y: number, i: number) => ({
      k: `${k}#1`,
      y,
      i,
      sid: "capabilities",
      rg: "DIV/2@0:800",
      rp: 100,
      ry: 100,
      rc: 0,
    });
    const anchor = (i: number) => ({
      k: "H2:Section anchor#1",
      y: 50,
      i,
      sid: "capabilities",
    });
    const a = [anchor(3), marker("H3:Capabilities", 165, 1), marker("P:Body", 230, 2)];
    const b = [anchor(13), marker("H3:Capabilities", 100, 11), marker("P:Body", 165, 12)];

    expect(correctiveRows(a, b, 1)).toEqual({
      a: [],
      b: [{ i: 11, px: 65, mode: "row" }],
    });
  });

  it("corrects item-internal gaps without moving its first anchor twice", () => {
    const marker = (k: string, y: number, i: number) => ({
      k: `${k}#1`,
      y,
      i,
      sid: "capabilities",
      rg: "DIV/2@0:800",
      rp: 100,
      ry: 100,
      rc: 0,
    });
    const a = [marker("H3:Capabilities", 165, 1), marker("P:Body", 250, 2)];
    const b = [marker("H3:Capabilities", 100, 11), marker("P:Body", 165, 12)];

    expect(correctiveItemFlows(a, b, 1)).toEqual({
      a: [],
      b: [{ i: 12, px: 20, mode: "el" }],
    });
  });

  it("aligns sparse terminal footer columns independently", () => {
    const a = [
      { k: "H2:Brand#1", y: 100, i: 1, s: "FOOTER/H2", rg: "DIV/2@0:800", rc: 0 },
      {
        k: "P:Copyright#1",
        y: 225,
        i: 2,
        s: "FOOTER/P",
        rg: "DIV/2@0:800",
        rc: 1,
      },
    ];
    const b = [
      { k: "H2:Brand#1", y: 100, i: 11, s: "FOOTER/H2", rg: "DIV/2@0:800", rc: 0 },
      {
        k: "P:Copyright#1",
        y: 200,
        i: 12,
        s: "FOOTER/P",
        rg: "DIV/2@0:800",
        rc: 1,
      },
    ];

    expect(correctiveFooterFlows(a, b, 1)).toEqual({
      a: [],
      b: [{ i: 12, px: 25, mode: "el" }],
    });
  });

  it("aligns trailing section anchors that are outside row layouts", () => {
    const marker = (k: string, y: number, i: number) => ({
      k: `${k}#1`,
      y,
      i,
      sid: "environments",
    });
    const a = [marker("H3:Intro", 100, 1), marker("P:Lead", 150, 2), marker("P:Tail", 400, 3)];
    const b = [marker("H3:Intro", 100, 11), marker("P:Lead", 150, 12), marker("P:Tail", 320, 13)];

    expect(correctiveSectionFlows(a, b, 1)).toEqual({
      a: [],
      b: [{ i: 13, px: 80, mode: "el" }],
    });
  });

});
