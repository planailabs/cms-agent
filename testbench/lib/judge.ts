/**
 * Bench-side judge — wraps test/llm-evaluator's judge() with the booted
 * server's env (JUDGE_MODEL from .env) and records every verdict into the
 * run report. Screenshots are saved next to the report and attached as
 * image_url parts.
 */
import { judge as evaluatorJudge, type EvalResult, type JudgeArtifact } from '../../test/llm-evaluator';
import { benchRun } from './env';
import { recordVerdict, saveArtifact } from './report';

export type { JudgeArtifact };

export async function judgeStep(opts: {
  scenario: string;
  step: string;
  criteria: string;
  artifacts?: JudgeArtifact[];
}): Promise<EvalResult> {
  const { env } = benchRun();
  const artifacts = opts.artifacts ?? [];
  const saved = artifacts
    .filter((a) => a.kind === 'screenshot')
    .map((a) => saveArtifact(`${opts.scenario}-${a.label}`, Buffer.from(a.content, 'base64')));
  const verdict = await evaluatorJudge(env, {
    step: opts.step,
    criteria: opts.criteria,
    artifacts,
  });
  recordVerdict({
    scenario: opts.scenario,
    step: opts.step,
    pass: verdict.pass,
    reasoning: verdict.reasoning,
    source: 'judge',
    artifacts: saved,
  });
  return verdict;
}

/** Record a deterministic check in the same report stream. */
export function recordAssert(scenario: string, step: string, pass: boolean, detail = ''): void {
  recordVerdict({ scenario, step, pass, reasoning: detail, source: 'assert' });
}
