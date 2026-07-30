/**
 * Background tickers across a dev module reload.
 *
 * The failure this guards against: the timer handle lives on globalThis, so a
 * reloaded module used to see it and return early — leaving the STALE timer
 * registered, whose callback can only throw "Vite module runner has been
 * closed" from then on. Warming and orphan cleanup silently stopped after the
 * first dev reload and nothing said so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModuleGraphGone, isTickerRunning, startTicker, stopTicker } from '@/lib/ticker';

afterEach(() => {
  stopTicker('t');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('background ticker', () => {
  it('lets the newest module evaluation take over the name', async () => {
    vi.useFakeTimers();
    const stale = vi.fn(async () => {});
    const fresh = vi.fn(async () => {});

    startTicker('t', 1000, stale);
    startTicker('t', 1000, fresh); // the module reloaded

    await vi.advanceTimersByTimeAsync(3000);
    // The old callback belongs to a torn-down graph — it must never run again.
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(3);
  });

  it('runs immediately only when asked', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    startTicker('t', 1000, run, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous one is still running', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    startTicker('t', 1000, run);

    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1); // still inside the first pass

    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps ticking after an ordinary failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = vi.fn(async () => {
      throw new Error('git is having a day');
    });
    startTicker('t', 1000, run);

    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(isTickerRunning('t')).toBe(true);
  });

  it('cancels itself when its module graph is gone', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = vi.fn(async () => {
      throw new Error('Vite module runner has been closed.');
    });
    startTicker('t', 1000, run);

    await vi.advanceTimersByTimeAsync(5000);
    // One throw is enough to know: this callback can only ever throw.
    expect(run).toHaveBeenCalledTimes(1);
    expect(isTickerRunning('t')).toBe(false);
  });

  it('recognizes only the torn-down-graph error', () => {
    expect(isModuleGraphGone(new Error('Vite module runner has been closed.'))).toBe(true);
    expect(isModuleGraphGone(new Error('ECONNREFUSED'))).toBe(false);
    expect(isModuleGraphGone('module runner has been closed')).toBe(false);
  });
});
