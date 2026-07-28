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

interface PrewarmState {
  /** Branch ready (or warming) for the next chat; null while none exists. */
  spare: string | null;
  warming: Promise<void> | null;
  /** Ticker re-warming the primary branches; null until started. */
  primaryTimer: ReturnType<typeof setInterval> | null;
}

// Survive Vite HMR module reloads in dev, like the preview manager.
const g = globalThis as unknown as { __cmsPrewarm?: PrewarmState };
const state: PrewarmState = (g.__cmsPrewarm ??= {
  spare: null,
  warming: null,
  primaryTimer: null,
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
  state.warming = warm(branch)
    .then(() => {
      state.spare = branch;
    })
    .catch((err) => {
      console.warn('[prewarm] warming a spare branch failed:', err);
    })
    .finally(() => {
      state.warming = null;
    });
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
  return claimed ?? newWorkBranch();
}

/**
 * Pin and start a preview for every branch chats can be created from, and
 * drop pins for branches that disappeared. Safe to call repeatedly: running
 * instances short-circuit, crashed ones restart.
 */
export async function warmPrimaryBranches(): Promise<void> {
  const { prisma } = await import('@/lib/db');
  const { defaultBranch } = await import('@/lib/git/engine');
  const { ensureInstance, isInstanceActive, pinBranch, pinnedBranches, unpinBranch } =
    await import('./manager');

  const rows = await prisma.branch.findMany({ select: { name: true } });
  const primary = new Set(rows.map((r) => r.name));
  primary.add(await defaultBranch()); // always startable, row or not

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
  if (state.primaryTimer) return;
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return; // a slow sweep must not stack up behind itself
    ticking = true;
    try {
      await warmPrimaryBranches();
      // The spare comes last and only once the branches users look at are
      // up — it is the least urgent of the three installs.
      ensureSpareBranch();
    } catch (err) {
      console.warn('[prewarm] primary-branch sweep failed:', err);
    } finally {
      ticking = false;
    }
  };
  state.primaryTimer = setInterval(() => void tick(), 60_000);
  // Don't hold the process open for the warmer.
  if (typeof state.primaryTimer === 'object' && 'unref' in state.primaryTimer) {
    state.primaryTimer.unref();
  }
  void tick();
}

/** Test seam: forget the spare without touching git. */
export function resetPrewarmForTests(): void {
  state.spare = null;
  state.warming = null;
  if (state.primaryTimer) clearInterval(state.primaryTimer);
  state.primaryTimer = null;
}
