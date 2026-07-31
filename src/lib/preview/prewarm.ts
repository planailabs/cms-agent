/**
 * Warm previews. Two halves:
 *
 * - Every branch a chat can be started from (the Branch rows: main and any
 *   long-lived branch) keeps its dev server running, pinned so the idle
 *   sweeper leaves it alone. Their previews are what a draft chat shows, so
 *   a cold one is a blank stage.
 * - One spare work branch, warmed ahead of the next chat. Creating a chat's
 *   worktree is cheap, but the first `npm install` in it is not — so a branch
 *   is prepared off the default branch (worktree + deps + dev server) and the
 *   next chat that targets the default branch adopts it instead of paying that
 *   cost while the user waits.
 *
 * ponytail: exactly ONE spare work branch, primed at boot and refilled after
 * it is claimed. Unlike the primary branches it is not pinned, so the idle
 * sweeper may stop its dev server — the expensive part, the installed
 * worktree, survives that. Grow into a real pool only if new chats start
 * arriving faster than one warms.
 */
import { randomBytes } from 'node:crypto';
import { startTicker, stopTicker } from '@/lib/ticker';

interface PrewarmState {
  /** Branch ready (or warming) for the next chat; null while none exists. */
  spare: string | null;
  warming: Promise<void> | null;
  /** Branch currently being warmed — it has no chat yet, so the orphan
   *  sweeper must not mistake it for leftovers. */
  warmingBranch: string | null;
}

// Survive Vite HMR module reloads in dev, like the preview manager.
const g = globalThis as unknown as { __cmsPrewarm?: PrewarmState };
const state: PrewarmState = (g.__cmsPrewarm ??= {
  spare: null,
  warming: null,
  warmingBranch: null,
});

/** Same shape as a chat work branch, so branch listings keep hiding it. */
const newWorkBranch = (): string => `c-${randomBytes(6).toString('hex')}`;

async function warm(branch: string): Promise<void> {
  const { defaultBranch, ensureBranch } = await import('@/lib/git/engine');
  const { ensureInstance } = await import('./manager');
  await ensureBranch(branch, await defaultBranch());
  await ensureInstance(branch); // worktree + npm install + dev server
}

/**
 * Start warming a spare unless one is ready or on the way. Fire-and-forget:
 * a failed warm just clears the slot so the next claim tries again.
 */
export function ensureSpareBranch(): void {
  if (state.spare || state.warming) return;
  const branch = newWorkBranch();
  state.warmingBranch = branch;
  state.warming = warm(branch)
    .then(() => {
      state.spare = branch;
    })
    .catch((err) => {
      console.warn('[prewarm] warming a spare branch failed:', err);
    })
    .finally(() => {
      state.warming = null;
      state.warmingBranch = null;
    });
}

/** Branches held by the pool: chat-less on purpose, never leftovers. */
export function reservedBranches(): string[] {
  return [state.spare, state.warmingBranch].filter((b): b is string => !!b);
}

/**
 * Take the warm branch for a chat, or mint a cold name when none is ready.
 * Only chats targeting the default branch may adopt a spare — it is branched
 * off that branch, so anything else would start from the wrong content.
 */
export async function claimWorkBranch(targetBranch: string): Promise<string> {
  const { defaultBranch } = await import('@/lib/git/engine');
  const adoptable = targetBranch === (await defaultBranch());
  const claimed = adoptable ? state.spare : null;
  if (claimed) state.spare = null;
  if (adoptable) ensureSpareBranch(); // refill for the chat after this one
  if (!claimed) return newWorkBranch();
  await catchUpWithTarget(claimed, targetBranch);
  return claimed;
}

/**
 * A spare is branched off the target when it is warmed and then sits there,
 * so every publish in the meantime leaves it a commit further behind. A chat
 * that starts behind its own target edits stale content, shows a diff against
 * the wrong base, and has to sync before it can publish — which is precisely
 * the wait the pool exists to remove.
 *
 * Reset it forward at the moment it is claimed. Nothing has been committed to
 * a spare (it has no chat yet), so there is nothing to preserve, and
 * node_modules is gitignored — the expensive part of the warm-up survives the
 * reset untouched. A failure here is not worth failing chat creation over: the
 * chat is then merely as stale as it would have been anyway.
 */
export async function catchUpWithTarget(branch: string, target: string): Promise<void> {
  try {
    const { branchAheadCount, resetBranchOnto } = await import('@/lib/git/engine');
    if ((await branchAheadCount(branch, target)) === 0) return;
    const { withBranchLock } = await import('@/lib/agent/bus');
    await withBranchLock(branch, () => resetBranchOnto(branch, target));
    console.log(`[prewarm] ${branch} reset onto ${target} before adoption`);
  } catch (err) {
    console.warn(`[prewarm] could not catch ${branch} up with ${target}:`, err);
  }
}

/**
 * Pin and start a preview for every branch chats can be created from, and
 * drop pins for branches that disappeared. Safe to call repeatedly: running
 * instances short-circuit, crashed ones restart.
 */
export async function warmPrimaryBranches(): Promise<void> {
  const { prisma } = await import('@/lib/db');
  const { branchExists, defaultBranch } = await import('@/lib/git/engine');
  const { ensureInstance, isInstanceActive, pinBranch, pinnedBranches, unpinBranch } =
    await import('./manager');

  const fallback = await defaultBranch();
  const rows = await prisma.branch.findMany({ select: { name: true } });
  // A Branch row outlives the ref it names — someone deletes the branch in the
  // repo, the row is reconciled later. Warming such a row would RECREATE the
  // branch (ensureWorktree → ensureBranch), so the deletion silently undoes
  // itself and the ghost gets a preview. Warm only what exists.
  const primary = new Set<string>();
  for (const row of rows) {
    if (await branchExists(row.name)) primary.add(row.name);
    else console.log(`[prewarm] skipping ${row.name}: the branch no longer exists in the repo`);
  }
  primary.add(fallback); // always startable, row or not

  for (const stale of pinnedBranches()) {
    if (!primary.has(stale)) unpinBranch(stale);
  }
  for (const branch of primary) {
    pinBranch(branch);
    // One at a time: concurrent `npm install`s starve each other, and a start
    // that misses its HTTP deadline gets restarted from scratch.
    if (isInstanceActive(branch)) continue;
    try {
      await ensureInstance(branch);
    } catch (err) {
      console.warn(`[prewarm] keeping ${branch} warm failed:`, err);
    }
  }
}

/**
 * Boot hook: warm the primary branches now and keep checking, so branches
 * created later (and dev servers that died) come back without a visitor.
 */
export function startPrimaryBranchWarmer(): void {
  startTicker(
    'prewarm',
    60_000,
    async () => {
      await warmPrimaryBranches();
      // The spare comes last and only once the branches users look at are
      // up — it is the least urgent of the three installs.
      ensureSpareBranch();
    },
    { immediate: true },
  );
}

/** Test seam: forget the spare without touching git. */
export function resetPrewarmForTests(): void {
  state.spare = null;
  state.warming = null;
  state.warmingBranch = null;
  stopTicker('prewarm');
}
