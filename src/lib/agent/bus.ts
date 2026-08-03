/**
 * SSE connection registry + turn/branch locks.
 * Ported from chat/src/lib/chat/handler (connection registry section);
 * keys changed from user:mode to chatId, plus a per-branch mutation lock so
 * only one chat writes to a branch worktree at a time.
 */

import { registerGauge } from '@/lib/metrics';

/** A live browser connection. Closing is the transport's business — the
 *  stream ends when the request is aborted — so there is nothing to call:
 *  end() had no caller anywhere and only suggested a shutdown path exists. */
export interface SSEWriter {
  write(event: string, data: unknown): void;
}

// globalThis-backed: Vite HMR reloads this module's graph in dev; plain
// module maps would split into old/new instances — live SSE connections
// stay registered in the old one and every broadcast (state snapshots!)
// goes nowhere until a restart. Same pattern as preview/manager.
interface BusState {
  connections: Map<string, Set<SSEWriter>>; // chatId -> connections
  activeTurns: Map<string, string>; // chatId -> lockId
  branchLocks: Map<string, string>; // branchId -> lockId
  stopRequests: Set<string>; // chatIds whose turn the user stopped
  lockCounter: number;
}
const g = globalThis as unknown as { __cmsBus?: BusState };
const bus: BusState = (g.__cmsBus ??= {
  connections: new Map(),
  activeTurns: new Map(),
  branchLocks: new Map(),
  stopRequests: new Set(),
  lockCounter: 0,
});
const connections = bus.connections;
const activeTurns = bus.activeTurns;
const branchLocks = bus.branchLocks;
const stopRequests = (bus.stopRequests ??= new Set());

// Counted at scrape time from the registry itself: a stream that leaks (the
// abort handler never fired) shows up here as a count that never comes down,
// which no per-connection counter would reveal.
registerGauge('cms.sse.streams', 'Open chat SSE connections', () => {
  let total = 0;
  for (const set of connections.values()) total += set.size;
  return total;
});
registerGauge('cms.turns.active', 'Chats with a turn in flight', () => activeTurns.size);

export function addConnection(chatId: string, writer: SSEWriter): () => void {
  let set = connections.get(chatId);
  if (!set) {
    set = new Set();
    connections.set(chatId, set);
  }
  set.add(writer);
  return () => {
    set.delete(writer);
    if (set.size === 0) connections.delete(chatId);
  };
}

export function broadcast(chatId: string, event: string, data: unknown): void {
  const set = connections.get(chatId);
  if (!set) return;
  for (const writer of set) {
    try {
      writer.write(event, data);
    } catch {
      // Writer closed — cleaned up on disconnect
    }
  }
}

function acquire(map: Map<string, string>, key: string): string | null {
  if (map.has(key)) return null;
  const lockId = `lock-${++bus.lockCounter}-${Date.now()}`;
  map.set(key, lockId);
  return lockId;
}

function release(map: Map<string, string>, key: string, lockId: string): void {
  if (map.get(key) === lockId) map.delete(key);
}

/** One in-flight turn per chat. */
export const acquireTurnLock = (chatId: string) => acquire(activeTurns, chatId);
export const releaseTurnLock = (chatId: string, id: string): void => {
  release(activeTurns, chatId, id);
  // The next turn starts fresh, whether this one stopped, finished or threw.
  if (!activeTurns.has(chatId)) stopRequests.delete(chatId);
};
export const hasActiveTurn = (chatId: string): boolean => activeTurns.has(chatId);

/**
 * Hold every listed chat idle while `fn` runs, or fail.
 *
 * Checking hasActiveTurn() and then acting is a race: the message endpoint can
 * start a turn in the gap, and a publish that merges a branch a turn is still
 * writing to merges a half-finished tree. Reserving takes the same lock a turn
 * takes, so the two cannot both win.
 *
 * Chats are locked in sorted order — a publish reserves the workflow chat and
 * its deployment chat, and two flows taking them in opposite orders would
 * deadlock. Every acquired lock is released even when fn throws.
 */
export async function withChatsReserved<T>(chatIds: string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(chatIds)].sort();
  const held: Array<[string, string]> = [];
  try {
    for (const chatId of ordered) {
      const lockId = acquireTurnLock(chatId);
      if (!lockId) {
        throw new Error('The agent is working in this chat — wait for the turn to finish, then try again.');
      }
      held.push([chatId, lockId]);
    }
    return await fn();
  } finally {
    for (const [chatId, lockId] of held) releaseTurnLock(chatId, lockId);
  }
}

/**
 * Ask the running turn to stop. The loop checks between streamed chunks and
 * between tool calls, so a stop lands at the next boundary — a tool already
 * executing (a build, an install) still runs to completion. Returns false when
 * there is no turn to stop.
 */
export function requestTurnStop(chatId: string): boolean {
  if (!activeTurns.has(chatId)) return false;
  stopRequests.add(chatId);
  return true;
}

/** True while the user's stop for this chat's turn is still pending. */
export const isTurnStopRequested = (chatId: string): boolean => stopRequests.has(chatId);

/**
 * Wait for a chat's turn to finish, up to `timeoutMs`. Returns whether it is
 * idle now.
 *
 * For human-facing actions that refuse to run on top of a turn: finalize
 * resumes the paused agent to close its finish_execution card, so the Publish
 * button a second later is racing a turn that is about to end on its own.
 * Waiting it out beats making the human click twice.
 */
export async function awaitTurnIdle(chatId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (hasActiveTurn(chatId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return !hasActiveTurn(chatId);
}

/**
 * One mutating owner per git resource (EXECUTE turns, commits, reverts,
 * merges, restores).
 *
 * The key is namespaced because this map used to receive BOTH kinds of
 * identifier under one parameter called `branchId`: Branch database ids from
 * the restore endpoint and the publisher, git ref names from everything else.
 * They cannot collide today, but nothing said so, and a rename on either side
 * would have made two different resources share a lock silently.
 */
const acquireResourceLock = (key: string) => acquire(branchLocks, key);
const releaseResourceLock = (key: string, id: string) => release(branchLocks, key, id);

/** Run fn holding a git-resource lock, waiting up to timeoutMs for it. */
async function withResourceLock<T>(
  key: string,
  fn: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  let lockId = acquireResourceLock(key);
  while (!lockId) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Branch is busy — another change is currently being applied.');
    }
    await new Promise((r) => setTimeout(r, 250));
    lockId = acquireResourceLock(key);
  }
  try {
    return await fn();
  } finally {
    releaseResourceLock(key, lockId);
  }
}

/** Serialize work on a chat's own work branch, named by its git ref. */
export const withWorkBranchLock = <T>(
  ref: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> => withResourceLock(`work:${ref}`, fn, timeoutMs);

/** Serialize work on a target branch, named by its Branch row id. */
export const withTargetBranchLock = <T>(
  branchId: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> => withResourceLock(`target:${branchId}`, fn, timeoutMs);
