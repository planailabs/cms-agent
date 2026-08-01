/**
 * Sync git reality into the DB: every eligible local branch of the managed
 * repo (incl. the default branch) gets a Branch row so it can be a chat
 * target; rows whose git branch vanished are reported, never deleted
 * (deleting would cascade chats). Also ensures the shared "Deployments"
 * system chat exists. Called lazily from GET /api/branches, throttled.
 */
import { prisma } from '@/lib/db';
import { defaultBranch, listRepoBranches, newWorkBranchName } from '@/lib/git/engine';

const SYNC_INTERVAL_MS = 5_000;
let lastSync = 0;

export interface BranchSyncResult {
  added: string[];
  /** DB branches whose git branch no longer exists (shown, not deleted). */
  missing: string[];
}

export async function syncBranchesFromRepo(force = false): Promise<BranchSyncResult> {
  if (!force && Date.now() - lastSync < SYNC_INTERVAL_MS) {
    return { added: [], missing: [] };
  }
  lastSync = Date.now();

  const [gitBranches, dbBranches] = await Promise.all([
    listRepoBranches(),
    prisma.branch.findMany({ select: { name: true } }),
  ]);
  const dbNames = new Set(dbBranches.map((b) => b.name));
  const gitNames = new Set(gitBranches);

  const added: string[] = [];
  for (const name of gitBranches) {
    if (!dbNames.has(name)) {
      await prisma.branch.create({ data: { name, createdById: null } });
      added.push(name);
    }
  }

  await ensureDeploymentsChat();

  return {
    added,
    missing: [...dbNames].filter((n) => !gitNames.has(n)),
  };
}

/** The single shared system chat over deployment/publication state. */
async function ensureDeploymentsChat(): Promise<void> {
  const existing = await prisma.chat.findFirst({ where: { kind: 'deployments' } });
  if (existing) return;
  const main = await prisma.branch.findUnique({ where: { name: await defaultBranch() } });
  if (!main) return;
  await prisma.chat.create({
    data: {
      branchId: main.id,
      workBranch: newWorkBranchName(),
      kind: 'deployments',
      title: 'Deployments',
      createdById: null, // system chat — no creator
    },
  });
}
