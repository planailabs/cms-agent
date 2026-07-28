/**
 * OPENAI_REASONING_EFFORT: defaults to 'medium'; 'none' is the explicit
 * opt-out for backends that reject the parameter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '@/lib/env';

const original = process.env.OPENAI_REASONING_EFFORT;

afterEach(() => {
  if (original === undefined) delete process.env.OPENAI_REASONING_EFFORT;
  else process.env.OPENAI_REASONING_EFFORT = original;
  resetEnvCache();
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
