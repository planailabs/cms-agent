/**
 * Deep chat deletion — stops the preview instance, removes the worktree and
 * git work branch (the .scratch/ area dies with the worktree), then deletes
 * the row (messages, publications, automatisms etc. cascade). Shared by the
 * admin chat manager and the archive view.
 */
import { prisma } from '@/lib/db';
import { deleteBranch, removeWorktree } from '@/lib/git/engine';
import { clearStartError, stopInstance } from '@/lib/preview/manager';

export async function deleteChatDeep(chat: { id: string; workBranch: string }): Promise<void> {
  await stopInstance(chat.workBranch);
  clearStartError(chat.workBranch);
  await removeWorktree(chat.workBranch);
  await deleteBranch(chat.workBranch);
  await prisma.chat.delete({ where: { id: chat.id } });
}
