/**
 * Streaming Animation Utilities
 *
 * Provides smooth character-by-character text streaming effects
 * similar to ChatGPT's response animation.
 */

/** Options for creating a stream ticker animation */
export interface StreamTickerOptions {
  /** Total duration in milliseconds (for fixed-duration animations) */
  duration?: number;
  /** Characters per millisecond (for variable-speed animations) */
  speed?: number;
  /** Target interval between ticks in milliseconds */
  intervalMs?: number;
  /** Callback invoked on each animation frame with progress and elapsed time */
  onTick: (progress: number, elapsed: number) => void;
  /** Callback invoked when the animation completes */
  onComplete: () => void;
}

/** Approximate frame rate for fallback setTimeout (60fps) */
const FALLBACK_FRAME_INTERVAL = 16;

/**
 * Cross-browser requestAnimationFrame with fallback.
 * Falls back to setTimeout for environments without rAF support.
 */
const requestFrame = (callback: FrameRequestCallback): number => {
  if (typeof requestAnimationFrame !== 'undefined') {
    return requestAnimationFrame(callback);
  }
  return setTimeout(
    () => callback(Date.now()),
    FALLBACK_FRAME_INTERVAL,
  ) as unknown as number;
};

/**
 * Cross-browser cancelAnimationFrame with fallback.
 */
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(id);
  } else {
    clearTimeout(id);
  }
};

/**
 * Creates a generic animation ticker using requestAnimationFrame.
 * Returns a cancel function to stop the animation.
 *
 * @param options - Configuration for the ticker
 * @returns A function to cancel the animation
 */
export const startStreamTicker = (
  options: StreamTickerOptions,
): (() => void) => {
  const startTime = Date.now();
  let rafId: number | null = null;
  let isRunning = true;

  const tick = (): void => {
    if (!isRunning) return;

    const now = Date.now();
    const elapsed = now - startTime;

    options.onTick(elapsed, elapsed);

    if (options.duration && elapsed >= options.duration) {
      isRunning = false;
      options.onComplete();
      return;
    }

    rafId = requestFrame(tick);
  };

  rafId = requestFrame(tick);

  return () => {
    isRunning = false;
    if (rafId !== null) cancelFrame(rafId);
  };
};

/**
 * Creates a character-by-character streaming animation.
 * Simulates typing effect by revealing characters over time.
 *
 * @param totalChars - Total number of characters to reveal
 * @param charsPerInterval - Number of characters to reveal per interval
 * @param intervalMs - Target interval in milliseconds
 * @param onUpdate - Callback with current visible character count
 * @param onComplete - Callback when all characters are revealed
 * @returns A function to cancel the animation
 *
 * @example
 * const cancel = startCharacterStream(
 *   text.length,
 *   3,  // 3 chars per interval
 *   28, // 28ms interval (~35ms effective for smooth animation)
 *   (count) => { element.textContent = text.slice(0, count); },
 *   () => { console.log('Stream complete'); }
 * );
 */
export const startCharacterStream = (
  totalChars: number,
  charsPerInterval: number,
  intervalMs: number,
  onUpdate: (visibleChars: number) => void,
  onComplete: () => void,
): (() => void) => {
  const startTime = Date.now();
  // Calculate characters per millisecond for smooth interpolation
  const charsPerMs = charsPerInterval / intervalMs;
  let rafId: number | null = null;
  let isRunning = true;

  const tick = (): void => {
    if (!isRunning) return;

    const now = Date.now();
    const elapsed = now - startTime;
    const expectedChars = Math.floor(elapsed * charsPerMs);
    const visibleChars = Math.min(totalChars, expectedChars);

    onUpdate(visibleChars);

    if (visibleChars >= totalChars) {
      isRunning = false;
      onComplete();
      return;
    }

    rafId = requestFrame(tick);
  };

  rafId = requestFrame(tick);

  return () => {
    isRunning = false;
    if (rafId !== null) cancelFrame(rafId);
  };
};
