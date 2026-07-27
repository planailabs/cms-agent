/**
 * Preview theme sync — the media-condition rewrite that emulates the chosen
 * scheme inside the preview (src/injected/module/theme.ts).
 */
import { describe, expect, it } from 'vitest';
import { rewriteCondition } from '@/injected/module/theme';

describe('rewriteCondition', () => {
  it('makes the matching scheme always apply and the other never', () => {
    expect(rewriteCondition('(prefers-color-scheme: dark)', 'dark')).toBe('(min-width: 0px)');
    expect(rewriteCondition('(prefers-color-scheme: dark)', 'light')).toBe('(max-width: 0px)');
    expect(rewriteCondition('(prefers-color-scheme: light)', 'light')).toBe('(min-width: 0px)');
    expect(rewriteCondition('(prefers-color-scheme: light)', 'dark')).toBe('(max-width: 0px)');
  });

  it('keeps the other terms of compound conditions', () => {
    expect(
      rewriteCondition('screen and (prefers-color-scheme: dark) and (min-width: 600px)', 'dark'),
    ).toBe('screen and (min-width: 0px) and (min-width: 600px)');
  });

  it('tolerates whitespace and case variants', () => {
    expect(rewriteCondition('( Prefers-Color-Scheme : DARK )', 'dark')).toBe('(min-width: 0px)');
  });

  it('leaves unrelated conditions alone', () => {
    expect(rewriteCondition('(min-width: 600px)', 'dark')).toBe('(min-width: 600px)');
  });
});
