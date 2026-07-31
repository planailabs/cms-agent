/**
 * Route history for the navigation bar — one stack per window that browses
 * (the preview and the compare view), because they are two different journeys
 * through the site and a shared stack would send Back to the other one's page.
 *
 * Model is the browser's, deliberately: visiting from the middle of the stack
 * truncates the forward tail. Anything else (keeping both futures, or a linear
 * "recently visited" list) makes Back mean something the user has to learn.
 *
 * State only — navigating is the caller's job (each scope reaches its pages
 * differently), so this module has no imports and stays unit-testable.
 */
export type NavScope = 'preview' | 'diff';

export interface NavHistory {
  entries: string[];
  /** Position in `entries`; -1 while nothing has been visited. */
  index: number;
}

/** Long enough to cover a session's browsing, short enough to render. */
export const NAV_HISTORY_LIMIT = 50;

export const createNavHistory = (): NavHistory => ({ entries: [], index: -1 });

export const currentEntry = (h: NavHistory): string | null => h.entries[h.index] ?? null;
export const canGoBack = (h: NavHistory): boolean => h.index > 0;
export const canGoForward = (h: NavHistory): boolean => h.index < h.entries.length - 1;

/**
 * Record a visit. Re-visiting the page already shown is not a history entry —
 * a reload, or the same route arriving from two sources (the address bar and
 * the iframe's own navigation event), must not stack duplicates that make Back
 * appear to do nothing.
 */
export function pushEntry(h: NavHistory, route: string): NavHistory {
  if (!route) return h;
  if (currentEntry(h) === route) return h;
  const kept = h.entries.slice(0, h.index + 1);
  kept.push(route);
  // Trim from the front: the oldest page is the one nobody is going back to.
  const entries = kept.slice(-NAV_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

/** Step back/forward and return the route to navigate to (null = at the end). */
export function step(h: NavHistory, delta: -1 | 1): { history: NavHistory; route: string | null } {
  const next = h.index + delta;
  if (next < 0 || next >= h.entries.length) return { history: h, route: null };
  return { history: { ...h, index: next }, route: h.entries[next] };
}

/** Jump to an absolute position (the history dropdown). */
export function jumpTo(h: NavHistory, index: number): { history: NavHistory; route: string | null } {
  if (index < 0 || index >= h.entries.length || index === h.index) return { history: h, route: null };
  return { history: { ...h, index }, route: h.entries[index] };
}
