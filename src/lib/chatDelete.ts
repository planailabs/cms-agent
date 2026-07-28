/**
 * Deep chat deletion — stops the preview instance, removes the worktree, git
 * work branch and sandbox homes (the .scratch/ area dies with the worktree),
 * then deletes the row (messages, publications, automatisms etc. cascade).
 * Shared by the admin chat manager and the archive view.
 */
import { prisma } from '@/lib/db';
import { discardBranchData, removeSandboxHome } from '@/lib/worktreeCleanup';

export async function deleteChatDeep(chat: { id: string; workBranch: string }): Promise<void> {
  await discardBranchData(chat.workBranch);
  // Sandbox homes are keyed by branch (preview installs) AND by chat id
  // (run_command, linting, codebase memory) — the npm cache in there is the
  // single biggest thing a chat leaves behind.
  removeSandboxHome(chat.id);
  await prisma.chat.delete({ where: { id: chat.id } });
}
