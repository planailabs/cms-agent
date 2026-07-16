/**
 * Publish Card Reducer — pure state logic for the publish progress card.
 *
 * The card is created when the user clicks Publish (start), receives
 * streamed `publish_log` lines, and is finalized by `publish_done`.
 * Kept free of store/DOM access so it is unit-testable.
 */

/** Maximum number of log lines kept in memory (older lines are dropped). */
export const MAX_PUBLISH_LOG_LINES = 200;

export interface PublishCardState {
  /** Branch head sha the publication was requested for. */
  sha: string;
  /** Server-assigned publication id (null until known). */
  publicationId: string | null;
  /** Streamed log lines (capped at MAX_PUBLISH_LOG_LINES). */
  lines: string[];
  status: 'running' | 'succeeded' | 'failed';
  error?: string;
  externalUrl?: string;
}

export type PublishCardEvent =
  | { type: 'start'; sha: string; publicationId?: string }
  | { type: 'log'; publicationId: string; line: string }
  | {
      type: 'done';
      publicationId: string;
      ok: boolean;
      sha?: string;
      error?: string;
      externalUrl?: string;
    };

/** True when the event belongs to a different publication than the card. */
const isForeign = (state: PublishCardState, publicationId: string): boolean =>
  state.publicationId !== null && state.publicationId !== publicationId;

/**
 * Applies a publish event to the current card state.
 * Returns the next state (never mutates the input).
 */
export const publishCardReducer = (
  state: PublishCardState | null,
  event: PublishCardEvent,
): PublishCardState | null => {
  switch (event.type) {
    case 'start':
      return {
        sha: event.sha,
        publicationId: event.publicationId ?? null,
        lines: [],
        status: 'running',
      };

    case 'log': {
      // Log for a publication we didn't start locally (other tab): adopt it.
      if (!state) {
        return {
          sha: '',
          publicationId: event.publicationId,
          lines: [event.line],
          status: 'running',
        };
      }
      if (isForeign(state, event.publicationId)) return state;
      return {
        ...state,
        publicationId: event.publicationId,
        lines: [...state.lines, event.line].slice(-MAX_PUBLISH_LOG_LINES),
      };
    }

    case 'done': {
      if (!state) {
        return {
          sha: event.sha ?? '',
          publicationId: event.publicationId,
          lines: [],
          status: event.ok ? 'succeeded' : 'failed',
          error: event.error,
          externalUrl: event.externalUrl,
        };
      }
      if (isForeign(state, event.publicationId)) return state;
      return {
        ...state,
        publicationId: event.publicationId,
        sha: event.sha ?? state.sha,
        status: event.ok ? 'succeeded' : 'failed',
        error: event.error,
        externalUrl: event.externalUrl,
      };
    }
  }
};
