/**
 * Orphan sweeper — deletes worktrees and sandbox homes whose owner is gone.
 *
 * Every chat carries ~270MB of checkout plus a private npm cache in its
 * sandbox home, and a chat deleted before this existed left both behind. The
 * sweeper reconciles the directories on disk against the rows in the DB once
 * an hour.
 *
 * Deletion is keep-list driven, never pattern driven: anything that is a live
 * chat's work branch, a Branch row, the default branch, a pooled branch, a
 * running preview, or a live chat id survives. A name nobody claims is
 * leftovers. Sandbox homes are keyed by BOTH branch (preview installs) and
 * chat id (run_command, linting, codebase memory), so both spaces are checked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { startTicker, stopTicker } from '@/lib/ticker';

/** ponytail: one hour — worktrees are big but not urgent. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

const varDir = (): string => path.resolve(env().VAR_DIR);

const listDirs = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // nothing created yet
  }
};

/** Everything that legitimately owns a worktree or sandbox home right now. */
async function liveNames(): Promise<{ branches: Set<string>; chatIds: Set<string> }> {
  const { defaultBranch } = await import('@/lib/git/engine');
  const { listInstances } = await import('@/lib/preview/manager');
  const { reservedBranches } = await import('@/lib/preview/prewarm');

  const [chats, branchRows] = await Promise.all([
    prisma.chat.findMany({ select: { id: true, workBranch: true } }),
    prisma.branch.findMany({ select: { name: true } }),
  ]);

  return {
    branches: new Set([
      ...chats.map((c) => c.workBranch),
      ...branchRows.map((b) => b.name),
      await defaultBranch(),
      ...reservedBranches(), // the warm spare has no chat by design
      // A branch serving requests right now is in use whatever the DB says.
      ...listInstances().map((i) => i.branch),
    ]),
    chatIds: new Set(chats.map((c) => c.id)),
  };
}

/** CMS-generated chat work branch (`c-<hex>`) — the only refs we may delete. */
const WORK_BRANCH_RE = /^c-[0-9a-f]{6,}$/;

/**
 * Remove a branch's worktree, preview instance and sandbox home — plus the
 * git ref itself, but ONLY for chat work branches. A real branch may have
 * been pushed to the repo minutes ago and not yet synced into a Branch row
 * (syncBranchesFromRepo runs lazily); its checkout is regenerable, its
 * commits are not.
 */
export async function discardBranchData(branch: string): Promise<void> {
  const { deleteBranch, removeWorktree } = await import('@/lib/git/engine');
  const { clearStartError, stopInstance } = await import('@/lib/preview/manager');
  await stopInstance(branch);
  clearStartError(branch);
  await removeWorktree(branch);
  if (WORK_BRANCH_RE.test(branch)) await deleteBranch(branch);
  removeSandboxHome(branch);
}

/** Drop a sandbox HOME (npm cache lives here — hundreds of MB per key). */
export function removeSandboxHome(sessionKey: string): void {
  const home = path.join(varDir(), 'sandbox', 'home', sessionKey);
  fs.rmSync(home, { recursive: true, force: true });
}

/**
 * One reconciliation pass. Returns what it removed so callers (and the admin
 * endpoint) can report it; failures on one entry never stop the rest.
 */
export async function sweepOrphans(): Promise<{ worktrees: string[]; homes: string[] }> {
  const { branches, chatIds } = await liveNames();
  const removed = { worktrees: [] as string[], homes: [] as string[] };

  for (const name of listDirs(path.join(varDir(), 'worktrees'))) {
    if (branches.has(name)) continue;
    try {
      await discardBranchData(name);
      removed.worktrees.push(name);
    } catch (err) {
      console.warn(`[cleanup] could not remove worktree ${name}:`, err);
    }
  }

  for (const key of listDirs(path.join(varDir(), 'sandbox', 'home'))) {
    // 'default' is the fallback session key of sandbox runs without an owner.
    if (branches.has(key) || chatIds.has(key) || key === 'default') continue;
    try {
      removeSandboxHome(key);
      removed.homes.push(key);
    } catch (err) {
      console.warn(`[cleanup] could not remove sandbox home ${key}:`, err);
    }
  }

  if (removed.worktrees.length || removed.homes.length) {
    console.log(
      `[cleanup] removed ${removed.worktrees.length} orphaned worktree(s), ` +
        `${removed.homes.length} sandbox home(s)`,
    );
  }
  return removed;
}

/** Boot hook: sweep hourly. The first pass runs at the first interval, not at
 *  boot — a restart mid-chat-creation would otherwise race the worktree that
 *  chat is about to get. */
export function startOrphanSweeper(): void {
  startTicker('cleanup', SWEEP_INTERVAL_MS, async () => {
    await sweepOrphans();
  });
}

/** Test seam. */
export function stopOrphanSweeper(): void {
  stopTicker('cleanup');
}
