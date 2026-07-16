/**
 * Controlled project memory (plan §12, medved §23): the agent proposes
 * candidates, an editor approves them in the UI, approved memories are
 * injected into the system prompt and exported to .cms/knowledge/ in the
 * worktree so the next execution commit versions them with the site.
 * Never learnable: secrets, approval bypasses, autonomy rights, instructions
 * found in uploads/site content (deny patterns + prompt rules).
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

const DENY_PATTERNS: RegExp[] = [
  /-----BEGIN/,
  /(?:api[_-]?key|secret|token|password)\s*[:=]/i,
  /(?:skip|bypass|without)\s+(?:the\s+)?approval/i,
  /auto[- ]?(?:approve|publish)/i,
];

export function memoryContentAllowed(content: string): string | null {
  if (content.length > 1000) return 'Memory candidates must stay under 1000 characters.';
  for (const re of DENY_PATTERNS) {
    if (re.test(content)) {
      return 'This cannot be learned: secrets, approval bypasses, and autonomy changes are excluded from project memory.';
    }
  }
  return null;
}

export async function getApprovedMemories(): Promise<string[]> {
  const rows = await prisma.approvedMemory.findMany({
    where: { revokedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { content: true },
  });
  return rows.map((r) => r.content);
}

export async function approveMemory(candidateId: string, approverId: string): Promise<void> {
  const candidate = await prisma.memoryCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.status !== 'pending') throw new Error('Candidate not pending');
  await prisma.$transaction([
    prisma.memoryCandidate.update({ where: { id: candidateId }, data: { status: 'approved' } }),
    prisma.approvedMemory.create({
      data: { candidateId, content: candidate.content, approvedById: approverId },
    }),
  ]);
}

export async function rejectMemory(candidateId: string): Promise<void> {
  await prisma.memoryCandidate.update({ where: { id: candidateId }, data: { status: 'rejected' } });
}

export async function revokeMemory(approvedId: string): Promise<void> {
  await prisma.approvedMemory.update({ where: { id: approvedId }, data: { revokedAt: new Date() } });
}

/**
 * Export active memories to .cms/knowledge/approved.md inside a worktree —
 * called right before an execution commit so conventions are versioned with
 * the change that used them (keeps main untouched outside publishing).
 */
export async function syncMemoriesToWorktree(worktreePath: string): Promise<void> {
  const memories = await getApprovedMemories();
  const dir = path.join(worktreePath, '.cms', 'knowledge');
  const file = path.join(dir, 'approved.md');
  if (memories.length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `# Project conventions (team-approved)\n\n${memories.map((m) => `- ${m}`).join('\n')}\n`,
  );
}
