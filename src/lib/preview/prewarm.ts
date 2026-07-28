/**
 * One spare work branch, warmed ahead of the next chat. Creating a chat's
 * worktree is cheap, but the first `npm install` in it is not — so a branch
 * is prepared off the default branch (worktree + deps + dev server) and the
 * next chat that targets the default branch adopts it instead of paying that
 * cost while the user waits.
 *
 * ponytail: exactly one spare, refilled after it is claimed. No boot-time
 * warm (the first chat after a restart primes the next one), and the idle
 * sweeper may stop an old spare's dev server — the expensive part, the
 * installed worktree, survives that. Grow into a real pool only if new chats
 * start arriving faster than one warms.
 */
import { randomBytes } from 'node:crypto';

interface PrewarmState {
  /** Branch ready (or warming) for the next chat; null while none exists. */
  spare: string | null;
  warming: Promise<void> | null;
}

// Survive Vite HMR module reloads in dev, like the preview manager.
const g = globalThis as unknown as { __cmsPrewarm?: PrewarmState };
const state: PrewarmState = (g.__cmsPrewarm ??= { spare: null, warming: null });

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

/** Test seam: forget the spare without touching git. */
export function resetPrewarmForTests(): void {
  state.spare = null;
  state.warming = null;
}
