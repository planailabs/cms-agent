/**
 * What one content alignment actually did.
 *
 * The alignment engine is the largest piece of heuristics in the project —
 * marker matching, structural spacing, bounded corrective rounds — and until
 * now it reported nothing except its result. That makes every proposal to
 * "simplify the heuristics" unanswerable: nobody can say how often
 * correspondence is weak, how many rounds a normal page takes, how often a
 * round regresses and throws its own work away, or whether the live view and
 * the server screenshots converge to the same place.
 *
 * So: one line per alignment, from both orchestrators, in a shape you can
 * grep and diff. Measurement first — the review is explicit that changing the
 * heuristics without it is guessing.
 */

export interface AlignmentReport {
  /** 'live' = the side-by-side iframes, 'server' = the screenshot pipeline.
   *  The pair is the point: they run the same engine on the same pages, so a
   *  divergence between them is a bug in one of the two environments. */
  source: 'live' | 'server';
  route: string;
  /** Markers collected per side. */
  markersA: number;
  markersB: number;
  /** matchConfidence: 0..1, and whether the collection was cut short. */
  confidence: number;
  matchRate: number;
  trustedRate: number;
  truncated: boolean;
  /** Spacers the structural plan injected, both sides. */
  spacers: number;
  /** Corrective rounds actually run, and what they were allowed. */
  rounds: number;
  maxRounds: number;
  /** Worst residual Y drift, before and after correction (px). */
  driftBefore: number;
  driftAfter: number;
  /** Ended early because the pair was replaced under it. */
  aborted: boolean;
  /** A round made drift worse; its DOM measurements were discarded. */
  regressed: boolean;
  /** Wall-clock of the whole alignment, ms. */
  ms: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Emit one alignment report.
 *
 * Deliberately a log line rather than a metrics backend: this is here to make
 * a decision possible, and a decision needs a few hundred runs, not a
 * dashboard. `[align-metrics]` is the grep handle.
 */
export function reportAlignment(report: AlignmentReport): void {
  const parts = [
    `source=${report.source}`,
    `route=${report.route}`,
    `markers=${report.markersA}/${report.markersB}`,
    `conf=${round(report.confidence)}`,
    `match=${round(report.matchRate)}`,
    `trusted=${round(report.trustedRate)}`,
    `spacers=${report.spacers}`,
    `rounds=${report.rounds}/${report.maxRounds}`,
    `drift=${round(report.driftBefore)}→${round(report.driftAfter)}`,
    `ms=${Math.round(report.ms)}`,
  ];
  if (report.truncated) parts.push('truncated');
  if (report.aborted) parts.push('aborted');
  if (report.regressed) parts.push('regressed');
  console.log(`[align-metrics] ${parts.join(' ')}`);
}
