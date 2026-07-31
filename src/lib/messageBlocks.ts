/**
 * Display blocks — what a chat message SHOWS, next to what it says.
 *
 * `content` is the message the model reads; it has to stay plain text, and
 * padding it with markup to make the transcript prettier costs tokens on every
 * turn. So a message can carry blocks alongside it: structured things the
 * browser renders (images, labelled facts, a handoff card) that the model
 * never sees.
 *
 * Kinds are additive by design — an unknown kind is skipped rather than
 * breaking the transcript, so an older client keeps working against a newer
 * server. Client-safe: no node imports, no database types.
 */
import type { TranslatedMessage } from './i18n/types';

/** One rendered image, addressed by the upload it came from. */
export interface BlockImage {
  uploadId: string;
  /** Short label under the image ("before", "after"). */
  label?: string;
  alt?: string;
}

/** One labelled number in a notice card ("Tool rounds · 250"). The value is a
 *  TranslatedMessage when it is a word rather than a number. */
export interface NoticeFact {
  label: TranslatedMessage;
  value: string | TranslatedMessage;
}

export type DisplayBlock =
  /** A localized server-written note (the existing TranslatedMessage). */
  | { kind: 'tm'; message: TranslatedMessage }
  /** Plain prose the model does not need to re-read. */
  | { kind: 'note'; text: string }
  /** Label/value pairs — a compact summary nobody should have to parse. */
  | { kind: 'facts'; rows: Array<{ label: string; value: string }> }
  /** Images side by side. */
  | { kind: 'images'; items: BlockImage[] }
  /**
   * An element-edit handoff: what the user drew, on which page, with the
   * before / requested / annotated shots that were sent to the agent.
   */
  /**
   * A turn that ended against a guard rail (round limit, plan↔execute
   * ping-pong). The agent's own "something went wrong" sentence says nothing
   * a person can act on; this says WHAT stopped, with the numbers behind it
   * and what to do next.
   */
  | {
      kind: 'notice';
      tone: 'limit' | 'error';
      title: TranslatedMessage;
      body: TranslatedMessage;
      facts?: NoticeFact[];
      /** One actionable line each — what the person can do about it. */
      hints?: TranslatedMessage[];
    }
  | {
      kind: 'handoff';
      route: string;
      note?: string;
      shots: BlockImage[];
      counts: { moves: number; swaps: number; strokes: number; comments: number };
    };

/** Storage envelope. Versioned so a reader can tell blocks from the legacy
 *  shapes the same column holds for other roles (tool calls, results). */
export interface BlockEnvelope {
  v: 1;
  blocks: DisplayBlock[];
}

export const blockEnvelope = (blocks: DisplayBlock[]): BlockEnvelope => ({ v: 1, blocks });

const KNOWN_KINDS = new Set(['tm', 'note', 'facts', 'images', 'handoff', 'notice']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read whatever is in the column into blocks.
 *
 * Three shapes exist in the wild: the envelope, a bare TranslatedMessage
 * (every automatism and cancel row ever written), and things that are not
 * display data at all (a tool-call array). Unknown kinds are dropped here so
 * one bad block cannot take a transcript down.
 */
export function normalizeBlocks(raw: unknown): DisplayBlock[] {
  if (isRecord(raw) && raw.v === 1 && Array.isArray(raw.blocks)) {
    return raw.blocks.filter(
      (b): b is DisplayBlock => isRecord(b) && typeof b.kind === 'string' && KNOWN_KINDS.has(b.kind),
    );
  }
  // Legacy: the column held the TranslatedMessage itself.
  if (isRecord(raw) && typeof raw.i18n === 'string' && typeof raw.fallback === 'string') {
    return [{ kind: 'tm', message: raw as unknown as TranslatedMessage }];
  }
  return [];
}

/** Browser URL for an upload's bytes (see api/uploads.ts mode=raw). */
export const uploadUrl = (uploadId: string): string =>
  `/api/uploads?id=${encodeURIComponent(uploadId)}&mode=raw`;
