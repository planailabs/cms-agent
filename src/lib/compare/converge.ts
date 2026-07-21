import type { MarkerDoc } from "./markers";
import {
  correctiveFlat,
  correctiveFooterFlows,
  correctiveItemFlows,
  correctiveLandmarks,
  correctiveRows,
  correctiveScopeLeads,
  correctiveSectionFlows,
  footerFlowYDelta,
  itemFlowYDelta,
  landmarkYDelta,
  matchedYDelta,
  rowYDelta,
  scopeLeadYDelta,
  sectionFlowYDelta,
  type SpacingPlan,
} from "./layout";

export const ALIGN_CORRECTIVE_THRESHOLD = 8;
export const ALIGN_CORRECTIVE_ROUNDS = 6;
export const ALIGN_CONFIDENCE_MIN = 0.35;

export interface CorrectiveAlignmentOptions {
  enabled?: boolean;
  threshold?: number;
  maxRounds?: number;
  /** Restrict corrections and convergence metrics to unique unchanged content
   *  or stable ids. Safe fallback when structural correspondence is weak. */
  trustedOnly?: boolean;
  /** Stops a stale live run before it mutates a replaced iframe pair. */
  isCurrent?: () => boolean;
  /** Reversibly probe the browser DOM and replace inferred spacer targets with
   * measured flow owners before committing a round. */
  refinePlan?: (plan: SpacingPlan) => Promise<SpacingPlan>;
}

export interface CorrectiveAlignmentResult {
  a: MarkerDoc;
  b: MarkerDoc;
  start: number;
  end: ReturnType<typeof matchedYDelta>;
  rounds: number;
  aborted: boolean;
  /** A mutation increased absolute drift. The returned DOM measurements are
   *  unsafe; callers must discard/reload the mutated pages before capture. */
  regressed: boolean;
}

/**
 * Converge an already structurally-reflowed pair using measured residuals.
 * The environment owns spacer application/recollection; this function owns the
 * stopping, confidence, and stale-run policy shared by screenshots and live UI.
 */
export const runCorrectiveAlignment = async (
  initialA: MarkerDoc,
  initialB: MarkerDoc,
  apply: (plan: SpacingPlan) => Promise<[MarkerDoc, MarkerDoc]>,
  options: CorrectiveAlignmentOptions = {},
): Promise<CorrectiveAlignmentResult> => {
  const threshold = options.threshold ?? ALIGN_CORRECTIVE_THRESHOLD;
  const maxRounds =
    options.maxRounds ??
    (options.trustedOnly ? ALIGN_CORRECTIVE_ROUNDS * 4 : ALIGN_CORRECTIVE_ROUNDS);
  const isCurrent = options.isCurrent ?? (() => true);
  let a = initialA;
  let b = initialB;
  const safeMetrics = (left: MarkerDoc, right: MarkerDoc) => [
    { name: "landmarks", report: landmarkYDelta(left.m, right.m) },
    { name: "scopeLeads", report: scopeLeadYDelta(left.m, right.m) },
    { name: "rows", report: rowYDelta(left.m, right.m) },
    { name: "items", report: itemFlowYDelta(left.m, right.m) },
    { name: "sections", report: sectionFlowYDelta(left.m, right.m) },
    { name: "footer", report: footerFlowYDelta(left.m, right.m) },
  ];
  const metric = (left: MarkerDoc, right: MarkerDoc) => {
    if (!options.trustedOnly) return matchedYDelta(left.m, right.m);
    const reports = safeMetrics(left, right).map((m) => m.report);
    const max = reports.reduce(
      (found, report) =>
        Math.abs(report.max) > Math.abs(found) ? report.max : found,
      0,
    );
    return {
      max,
      worst: reports
        .flatMap((report) => report.worst)
        .sort((p, q) => Math.abs(q.dy) - Math.abs(p.dy))
        .slice(0, 8),
    };
  };
  const start = metric(a, b).max;
  let rounds = 0;
  let aborted = !isCurrent();
  let regressed = false;
  let previous = Math.abs(start);
  const safeStages = [
    "landmarks",
    "scopeLeads",
    "rows",
    "items",
    "sections",
    "finalLandmarks",
    "footer",
  ] as const;
  let safeStageIndex = 0;

  while (
    !aborted &&
    options.enabled !== false &&
    rounds < maxRounds &&
    Math.abs(metric(a, b).max) > threshold
  ) {
    let selectedMetric = previous;
    let measureSelected = () => metric(a, b);
    let plan: SpacingPlan;
    if (options.trustedOnly) {
      const reports = Object.fromEntries(
        safeMetrics(a, b).map((entry) => [entry.name, entry.report]),
      ) as Record<
        "landmarks" | "scopeLeads" | "rows" | "items" | "sections" | "footer",
        ReturnType<typeof matchedYDelta>
      >;
      while (safeStageIndex < safeStages.length) {
        const stage = safeStages[safeStageIndex];
        const report = reports[stage === "finalLandmarks" ? "landmarks" : stage];
        if (Math.abs(report.max) > threshold) break;
        safeStageIndex++;
      }
      if (safeStageIndex >= safeStages.length) break;
      const stage = safeStages[safeStageIndex];
      const report = reports[stage === "finalLandmarks" ? "landmarks" : stage];
      selectedMetric = Math.abs(report.max);
      if (stage === "landmarks" || stage === "finalLandmarks") {
        plan = correctiveLandmarks(a.m, b.m);
        measureSelected = () => landmarkYDelta(a.m, b.m);
      } else if (stage === "scopeLeads") {
        plan = correctiveScopeLeads(a.m, b.m);
        measureSelected = () => scopeLeadYDelta(a.m, b.m);
      } else if (stage === "rows") {
        plan = correctiveRows(a.m, b.m);
        measureSelected = () => rowYDelta(a.m, b.m);
      } else if (stage === "items") {
        plan = correctiveItemFlows(a.m, b.m);
        measureSelected = () => itemFlowYDelta(a.m, b.m);
      } else if (stage === "footer") {
        plan = correctiveFooterFlows(a.m, b.m);
        measureSelected = () => footerFlowYDelta(a.m, b.m);
      } else {
        plan = correctiveSectionFlows(a.m, b.m);
        measureSelected = () => sectionFlowYDelta(a.m, b.m);
      }
    } else {
      plan = correctiveFlat(a.m, b.m);
    }
    if (!isCurrent()) {
      aborted = true;
      break;
    }
    if (options.refinePlan) plan = await options.refinePlan(plan);
    if (!plan.a.length && !plan.b.length) break;
    if (!isCurrent()) {
      aborted = true;
      break;
    }
    [a, b] = await apply(plan);
    rounds++;
    aborted = !isCurrent();
    const current = Math.abs(measureSelected().max);
    const regressionLimit = options.trustedOnly
      ? Math.max(selectedMetric + 32, selectedMetric * 1.5)
      : selectedMetric + threshold;
    if (!aborted && current > regressionLimit) {
      regressed = true;
      break;
    }
    if (options.trustedOnly) {
      const stalled = current >= selectedMetric - 1;
      if (stalled || current <= threshold) safeStageIndex++;
    }
    previous = Math.abs(metric(a, b).max);
  }

  if (!aborted && Math.abs(metric(a, b).max) > Math.abs(start) + threshold)
    regressed = true;

  return {
    a,
    b,
    start,
    end: metric(a, b),
    rounds,
    aborted,
    regressed,
  };
};
