/**
 * SSE connection registry + turn/branch locks.
 * Ported from chat/src/lib/chat/handler (connection registry section);
 * keys changed from user:mode to chatId, plus a per-branch mutation lock so
 * only one chat writes to a branch worktree at a time.
 */

export interface SSEWriter {
  write(event: string, data: unknown): void;
  end(): void;
}

const connections = new Map<string, Set<SSEWriter>>(); // chatId -> connections
const activeTurns = new Map<string, string>(); // chatId -> lockId
const branchLocks = new Map<string, string>(); // branchId -> lockId
let lockCounter = 0;

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
  const lockId = `lock-${++lockCounter}-${Date.now()}`;
  map.set(key, lockId);
  return lockId;
}

function release(map: Map<string, string>, key: string, lockId: string): void {
  if (map.get(key) === lockId) map.delete(key);
}

/** One in-flight turn per chat. */
export const acquireTurnLock = (chatId: string) => acquire(activeTurns, chatId);
export const releaseTurnLock = (chatId: string, id: string) => release(activeTurns, chatId, id);

/** One mutating chat per branch worktree (EXECUTE turns, commits, reverts). */
export const acquireBranchLock = (branchId: string) => acquire(branchLocks, branchId);
export const releaseBranchLock = (branchId: string, id: string) => release(branchLocks, branchId, id);

/** Run fn holding the branch lock, waiting up to timeoutMs for it. */
export async function withBranchLock<T>(
  branchId: string,
  fn: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  let lockId = acquireBranchLock(branchId);
  while (!lockId) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Branch is busy — another change is currently being applied.');
    }
    await new Promise((r) => setTimeout(r, 250));
    lockId = acquireBranchLock(branchId);
  }
  try {
    return await fn();
  } finally {
    releaseBranchLock(branchId, lockId);
  }
}
