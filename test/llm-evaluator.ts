/**
 * LLM quality judge (ported from chat/test/haiku-evaluator.ts, retargeted at
 * the configured OpenAI-compatible endpoint). `judge()` grades an arbitrary
 * step from labeled artifacts (text, JSON, screenshots) with JUDGE_MODEL —
 * the testbench's grader — falling back to OPENAI_MODEL.
 */
import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

export interface EvalResult {
  pass: boolean;
  reasoning: string;
}

export interface JudgeArtifact {
  kind: 'text' | 'json' | 'screenshot';
  label: string;
  /** Text/JSON content, or base64-encoded PNG for screenshots. */
  content: string;
}

export interface JudgeInput {
  /** What happened — the action/prompt/query under test. */
  step: string;
  /** What a passing outcome looks like. */
  criteria: string;
  artifacts?: JudgeArtifact[];
  model?: string;
}

const ARTIFACT_CHAR_BUDGET = 20_000;

const artifactText = (a: JudgeArtifact): string => {
  const body =
    a.content.length > ARTIFACT_CHAR_BUDGET
      ? `${a.content.slice(0, ARTIFACT_CHAR_BUDGET)}\n… (truncated, ${a.content.length} chars total)`
      : a.content;
  return `--- ${a.label} (${a.kind}) ---\n\`\`\`\n${body}\n\`\`\``;
};

export async function judge(env: Record<string, string>, input: JudgeInput): Promise<EvalResult> {
  const openai = new OpenAI({ baseURL: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY });
  const model = input.model ?? env.JUDGE_MODEL ?? env.OPENAI_MODEL;

  const artifacts = input.artifacts ?? [];
  const textual = artifacts.filter((a) => a.kind !== 'screenshot');
  const shots = artifacts.filter((a) => a.kind === 'screenshot');

  const parts: ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: `You are grading one step of an automated test run against a CMS application.

Step under test: ${input.step}

Pass criteria: ${input.criteria}

${textual.map(artifactText).join('\n\n')}${shots.length > 0 ? `\n\nAttached screenshot(s): ${shots.map((s) => s.label).join(', ')}` : ''}

Judge strictly against the criteria. Reply with exactly "PASS: <one sentence>" or "FAIL: <one sentence>".`,
    },
    ...shots.map(
      (s): ChatCompletionContentPart => ({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${s.content}` },
      }),
    ),
  ];

  const completion = await openai.chat.completions.create({
    model,
    max_tokens: 300,
    messages: [{ role: 'user', content: parts }],
  });

  const text = completion.choices[0].message.content ?? '';
  return { pass: text.trimStart().toUpperCase().startsWith('PASS'), reasoning: text.trim() };
}

export async function evaluateExchange(
  env: Record<string, string>,
  userMessage: string,
  assistantResponse: string,
  criteria: string,
): Promise<EvalResult> {
  return judge(env, {
    step: `The user asked the CMS assistant: ${userMessage}`,
    criteria,
    artifacts: [{ kind: 'text', label: 'Assistant response', content: assistantResponse }],
  });
}
