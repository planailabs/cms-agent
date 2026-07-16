/**
 * LLM conversation-quality judge (ported from chat/test/haiku-evaluator.ts,
 * retargeted at the configured OpenAI-compatible endpoint).
 */
import OpenAI from 'openai';

export interface EvalResult {
  pass: boolean;
  reasoning: string;
}

export async function evaluateExchange(
  env: Record<string, string>,
  userMessage: string,
  assistantResponse: string,
  criteria: string,
): Promise<EvalResult> {
  const openai = new OpenAI({ baseURL: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY });

  const completion = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You are grading a CMS assistant's reply.

User message: ${userMessage}

Assistant response: ${assistantResponse}

Criteria: ${criteria}

Reply with exactly "PASS: <one sentence>" or "FAIL: <one sentence>".`,
      },
    ],
  });

  const text = completion.choices[0].message.content ?? '';
  return { pass: text.trimStart().toUpperCase().startsWith('PASS'), reasoning: text.trim() };
}
