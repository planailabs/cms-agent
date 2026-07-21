import type { MarkerDoc } from "./markers";
import {
  correctiveFlat,
  correctiveTrusted,
  matchedYDelta,
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
  const maxRounds = options.maxRounds ?? ALIGN_CORRECTIVE_ROUNDS;
  const isCurrent = options.isCurrent ?? (() => true);
  let a = initialA;
  let b = initialB;
  const metric = (left: MarkerDoc, right: MarkerDoc) =>
    matchedYDelta(left.m, right.m, options.trustedOnly);
  const start = metric(a, b).max;
  let rounds = 0;
  let aborted = !isCurrent();
  let regressed = false;
  let previous = Math.abs(start);

  while (
    !aborted &&
    options.enabled !== false &&
    rounds < maxRounds &&
    Math.abs(metric(a, b).max) > threshold
  ) {
    const plan = options.trustedOnly
      ? correctiveTrusted(a.m, b.m)
      : correctiveFlat(a.m, b.m);
    if (!plan.a.length && !plan.b.length) break;
    if (!isCurrent()) {
      aborted = true;
      break;
    }
    [a, b] = await apply(plan);
    rounds++;
    aborted = !isCurrent();
    const current = Math.abs(metric(a, b).max);
    if (!aborted && current > previous + threshold) {
      regressed = true;
      break;
    }
    previous = current;
  }

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
