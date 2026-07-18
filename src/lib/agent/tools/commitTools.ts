/**
 * git_commit — EXECUTE-phase tool: the agent commits its own changes as it
 * works. Each commit is validated (secret scan etc.), recorded as an
 * Execution row, and announced via execution_committed so it shows as a
 * card and stays revertable. All commits on the work branch are merged
 * into the target branch by the publish flow.
 */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { broadcast, withBranchLock } from '../bus';
import { commitExecution } from '@/lib/git/engine';
import { chatCommitTrailer, chatGitIdentity } from '@/lib/git/identity';
import { hasErrors, validateWorktree } from '@/lib/validate';
import { registerTool, type ToolDef } from './registry';

const gitCommitTool: ToolDef = {
  name: 'git_commit',
  description:
    'Commit ALL current worktree changes with a message. Commit at every completed ' +
    'step; every change must be committed before finish_execution is accepted.',
  schema: z.object({
    message: z.string().min(3).max(500).describe('Commit message describing the change'),
  }),
  phases: ['execute'],
  kinds: ['workflow', 'deployment'],
  async execute(input, ctx) {
    const issues = await validateWorktree(ctx.worktreePath);
    if (hasErrors(issues)) {
      return JSON.stringify({
        error: `Validation failed — fix these before committing:\n${issues
          .filter((i) => i.severity === 'error')
          .map((i) => `- ${i.message}`)
          .join('\n')}`,
      });
    }
    // Commit as the chat's creator (falling back to the acting user, then CMS).
    const identity = await chatGitIdentity(ctx.chatId, ctx.userId);
    const trailer = await chatCommitTrailer(ctx.chatId);
    const sha = await withBranchLock(ctx.branchName, () =>
      commitExecution(ctx.branchName, `${input.message}\n\n${trailer}`, identity),
    );
    if (!sha) return JSON.stringify({ success: false, message: 'Nothing to commit — worktree is clean.' });
    await prisma.execution.create({ data: { chatId: ctx.chatId, sha, summary: input.message } });
    broadcast(ctx.chatId, 'execution_committed', {
      type: 'execution_committed',
      sha,
      summary: input.message,
    });
    return JSON.stringify({ success: true, sha });
  },
};

export function registerCommitTools(): void {
  registerTool(gitCommitTool);
}
