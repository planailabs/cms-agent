/**
 * Git author/committer identity resolution — every commit-creating git op
 * (commitExecution, mergeInto, revertCommit, restoreVersion) requires a
 * GitIdentity. Resolve it from the chat's creator (the users table), falling
 * back to the acting user, then a CMS default, so commits are never made with
 * an unset identity ("Committer identity unknown").
 */
import { prisma } from '@/lib/db';
import type { GitIdentity } from './engine';

export const CMS_IDENTITY: GitIdentity = { name: 'CMS Agent', email: 'agent@cms.invalid' };

/** Identity for a commit on a chat's work branch: chat creator → acting user → CMS. */
export async function chatGitIdentity(chatId: string, fallbackUserId?: string): Promise<GitIdentity> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { createdBy: { select: { name: true, email: true } } },
  });
  if (chat?.createdBy) return chat.createdBy;
  if (fallbackUserId) {
    const user = await prisma.user.findUnique({
      where: { id: fallbackUserId },
      select: { name: true, email: true },
    });
    if (user) return user;
  }
  return CMS_IDENTITY;
}
