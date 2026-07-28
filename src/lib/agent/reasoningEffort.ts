/**
 * reasoning_effort forwarding with backend fallback. Default effort is
 * OPENAI_REASONING_EFFORT (medium); OpenAI-compatible proxies differ on
 * support (litellm 400s with "does not support parameters:
 * ['reasoning_effort']" unless drop_params is enabled), so the first such
 * rejection drops the param for the rest of the process and retries once.
 */
import { env } from '@/lib/env';

let unsupported = false;

/** Spreadable param object — {} when effort is 'none' or unsupported. */
export const reasoningEffortParam = (): { reasoning_effort?: 'low' | 'medium' | 'high' } => {
  const effort = env().OPENAI_REASONING_EFFORT;
  return effort === 'none' || unsupported ? {} : { reasoning_effort: effort };
};

const rejectsEffort = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('reasoning_effort');

/**
 * Run an OpenAI call built with reasoningEffortParam(); if the backend
 * rejects the param, disable it process-wide and retry once (the thunk must
 * rebuild its params so the retry omits it).
 */
export const withEffortFallback = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (!unsupported && reasoningEffortParam().reasoning_effort && rejectsEffort(err)) {
      unsupported = true;
      console.warn('[agent] backend rejects reasoning_effort — dropping it for this process');
      return fn();
    }
    throw err;
  }
};

/** Test hook. */
export const resetReasoningEffortForTests = (): void => {
  unsupported = false;
};
