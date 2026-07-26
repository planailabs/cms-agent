/**
 * Verdict recording — scenario files (separate vitest workers) append
 * JSON-lines to <resultsDir>/verdicts.jsonl; the launcher renders report.md
 * from it after the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { benchRun } from './env';

export interface Verdict {
  scenario: string;
  step: string;
  pass: boolean;
  reasoning: string;
  /** 'judge' = JUDGE_MODEL graded; 'assert' = deterministic assertion. */
  source: 'judge' | 'assert';
  artifacts?: string[];
}

export function recordVerdict(v: Verdict): void {
  const dir = benchRun().resultsDir;
  fs.appendFileSync(path.join(dir, 'verdicts.jsonl'), `${JSON.stringify(v)}\n`);
}

/** Save a PNG artifact into the results dir; returns the relative filename. */
export function saveArtifact(label: string, png: Buffer): string {
  const name = `${label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${Date.now()}.png`;
  fs.writeFileSync(path.join(benchRun().resultsDir, name), png);
  return name;
}
