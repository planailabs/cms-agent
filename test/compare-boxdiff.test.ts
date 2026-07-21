/**
 * Change-detection oracle (boxDiff). Pins the flat classifier — matched +
 * text-differs = changed, one-sided = added/removed — on REAL captured plan.ai
 * markers (test/fixtures/align/real/*), plus synthetic add/remove derived from
 * them. Regression guard for the Phase-2 decoupling of boxDiff from the guillotine.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boxDiff } from "@/lib/compare/layout";
import type { MarkerDoc } from "@/lib/compare/markers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (n: string) =>
  JSON.parse(
    readFileSync(path.join(dir, "fixtures/align/real", n), "utf8"),
  ) as MarkerDoc;
const before = load("inflection-before.json");
const after = load("inflection-after.json");
const kinds = (boxes: ReturnType<typeof boxDiff>) => ({
  added: boxes.filter((x) => x.kind === "added").length,
  changed: boxes.filter((x) => x.kind === "changed").length,
  removed: boxes.filter((x) => x.kind === "removed").length,
});

describe("boxDiff (flat classifier)", () => {
  it("a reworded page → matched leaves flagged changed, not add+remove", () => {
    const boxes = boxDiff(before.m, before.h, after.m, after.h);
    const k = kinds(boxes);
    // The whole page was reworded in place → the bulk is 'changed'.
    expect(k.changed).toBeGreaterThan(100);
    // A reworded-in-place cell is one amber box, not a red+green pair.
    expect(k.added).toBeLessThan(20);
    expect(k.removed).toBeLessThan(20);
    // Every box carries real geometry.
    for (const bx of boxes) {
      expect(bx.w).toBeGreaterThan(0);
      expect(bx.h).toBeGreaterThan(0);
    }
  });

  it("genuinely removed leaves → removed boxes (mapped to after-space)", () => {
    // Drop 6 leaves from the AFTER side: they exist only in before → removed.
    const dropped = new Set([10, 12, 14, 40, 42, 44]);
    const b = { ...after, m: after.m.filter((_, i) => !dropped.has(i)) };
    const k = kinds(boxDiff(before.m, before.h, b.m, b.h));
    expect(k.removed).toBeGreaterThanOrEqual(4);
  });

  it("genuinely added leaves → added boxes", () => {
    // Drop 6 leaves from the BEFORE side: after has extras → added.
    const dropped = new Set([10, 12, 14, 40, 42, 44]);
    const a = { ...before, m: before.m.filter((_, i) => !dropped.has(i)) };
    const k = kinds(boxDiff(a.m, a.h, after.m, after.h));
    expect(k.added).toBeGreaterThanOrEqual(4);
  });

  it("identical input → no highlights", () => {
    expect(boxDiff(before.m, before.h, before.m, before.h)).toHaveLength(0);
  });
});
