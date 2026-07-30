/**
 * Named background tickers — at most one per name per process.
 *
 * Handles live on globalThis for the usual reason (see bus.ts): Vite reloads
 * server modules in dev, and a module-level map would fork. But a timer is not
 * like a connection registry — the CALLBACK belongs to the module evaluation
 * that created it, and after a reload that evaluation's dynamic imports throw
 * "Vite module runner has been closed" forever. So the ownership rule is the
 * opposite of the usual one:
 *
 * - The newest evaluation wins. `startTicker` replaces any existing timer of
 *   the same name instead of returning early, so a reloaded module gets a
 *   ticker wired into the live module graph.
 * - A ticker whose graph is already gone cancels itself on the next tick,
 *   rather than logging a stack trace once a minute until the process dies.
 *
 * The alternative — an early return when a timer already exists — silently
 * stops the work after the first dev reload, because the stale timer is still
 * registered and only ever throws.
 */

interface TickerState {
  timers: Map<string, ReturnType<typeof setInterval>>;
  running: Set<string>;
}

const g = globalThis as unknown as { __cmsTickers?: TickerState };
const state: TickerState = (g.__cmsTickers ??= { timers: new Map(), running: new Set() });

/** Dev-only: this callback's module graph was torn down by Vite. */
export const isModuleGraphGone = (err: unknown): boolean =>
  err instanceof Error && /module runner has been closed/i.test(err.message);

export interface TickerOptions {
  /** Run once immediately, not only after the first interval. */
  immediate?: boolean;
}

/**
 * (Re)arm a ticker. Overlapping runs are skipped — a slow pass must not stack
 * up behind itself — and a failed pass is logged, never fatal.
 */
export function startTicker(
  name: string,
  intervalMs: number,
  run: () => Promise<void>,
  opts: TickerOptions = {},
): void {
  stopTicker(name);

  const tick = async (): Promise<void> => {
    if (state.running.has(name)) return;
    state.running.add(name);
    try {
      await run();
    } catch (err) {
      if (isModuleGraphGone(err)) {
        // Dev reload: the next evaluation of the owning module arms a fresh
        // ticker. This one can only throw from here on.
        console.log(`[${name}] stopping the ticker of a reloaded module`);
        stopTicker(name);
        return;
      }
      console.warn(`[${name}] tick failed:`, err);
    } finally {
      state.running.delete(name);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Never hold the process open for background work.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  state.timers.set(name, timer);

  if (opts.immediate) void tick();
}

export function stopTicker(name: string): void {
  const timer = state.timers.get(name);
  if (timer) clearInterval(timer);
  state.timers.delete(name);
  state.running.delete(name);
}

/** Test seam. */
export function isTickerRunning(name: string): boolean {
  return state.timers.has(name);
}
