/**
 * OPENAI_REASONING_EFFORT: defaults to 'medium'; 'none' is the explicit
 * opt-out for backends that reject the parameter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '@/lib/env';
import {
  reasoningEffortParam,
  resetReasoningEffortForTests,
  withEffortFallback,
} from '@/lib/agent/reasoningEffort';

const original = process.env.OPENAI_REASONING_EFFORT;

afterEach(() => {
  if (original === undefined) delete process.env.OPENAI_REASONING_EFFORT;
  else process.env.OPENAI_REASONING_EFFORT = original;
  resetEnvCache();
  resetReasoningEffortForTests();
});

describe('reasoning effort env', () => {
  it('defaults to medium', () => {
    delete process.env.OPENAI_REASONING_EFFORT;
    resetEnvCache();
    expect(env().OPENAI_REASONING_EFFORT).toBe('medium');
  });

  it('accepts the explicit none opt-out', () => {
    process.env.OPENAI_REASONING_EFFORT = 'none';
    resetEnvCache();
    expect(env().OPENAI_REASONING_EFFORT).toBe('none');
  });

  it('rejects unknown values', () => {
    process.env.OPENAI_REASONING_EFFORT = 'maximum';
    resetEnvCache();
    expect(() => env()).toThrow(/OPENAI_REASONING_EFFORT/);
  });
});

describe('backend fallback', () => {
  it('drops the param and retries once when the backend rejects it', async () => {
    delete process.env.OPENAI_REASONING_EFFORT;
    resetEnvCache();
    expect(reasoningEffortParam()).toEqual({ reasoning_effort: 'medium' });

    // litellm-style rejection on the first call only
    let calls = 0;
    const result = await withEffortFallback(async () => {
      calls += 1;
      if (reasoningEffortParam().reasoning_effort) {
        throw new Error(
          "litellm.UnsupportedParamsError: codex does not support parameters: ['reasoning_effort']",
        );
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    // sticky for the rest of the process
    expect(reasoningEffortParam()).toEqual({});
  });

  it('rethrows unrelated errors without retrying', async () => {
    delete process.env.OPENAI_REASONING_EFFORT;
    resetEnvCache();
    let calls = 0;
    await expect(
      withEffortFallback(async () => {
        calls += 1;
        throw new Error('rate limited');
      }),
    ).rejects.toThrow('rate limited');
    expect(calls).toBe(1);
  });
});
