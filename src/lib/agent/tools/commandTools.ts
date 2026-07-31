/**
 * run_command — EXECUTE-phase tool to run a shell command inside the same
 * bubblewrap sandbox all site commands use: PATH is node + npm +
 * node_modules/.bin + coreutils, the repo root is the cwd, the store is
 * overshadowed, and only the worktree is writable. Network is on by default
 * (so `npm install` works) unless SANDBOX_ALLOW_NETWORK=0. Changes still need
 * git_commit before finish_execution.
 */
import { z } from 'zod';
import { ensureSandbox, runSandboxed } from '@/lib/sandbox';
import { findPausedAutomatism } from '@/lib/automatism';
import { DEPLOY_WRITE_REFUSAL } from './fsTools';
import { registerTool, type ToolDef } from './registry';

const runCommandTool: ToolDef = {
  name: 'run_command',
  description:
    'Run a shell command in the sandboxed site environment (cwd = repo root; ' +
    'PATH has node, npm, the repo\'s node_modules/.bin, coreutils, GNU grep/awk, ' +
    'and ripgrep (rg)). Use for builds, codegen, formatters, package scripts, ' +
    'searches, dependency installs, etc. Only the repo is writable; commit ' +
    'changes with git_commit afterwards.',
  schema: z.object({
    command: z.string().min(1).describe('Shell command, e.g. "npm run build" or "npx prettier -w ."'),
    timeoutSeconds: z.number().int().positive().max(600).default(120),
  }),
  phases: ['execute'],
  kinds: ['workflow', 'deployment'],
  async execute(input, ctx) {
    // The worktree is writable in here, so a deployment chat needs the same
    // "only while the deploy is paused" gate the file tools apply.
    if (ctx.chatKind === 'deployment' && !(await findPausedAutomatism(ctx.chatId))) {
      return JSON.stringify({ error: DEPLOY_WRITE_REFUSAL });
    }
    const sb = await ensureSandbox();
    const r = await runSandboxed(sb, input.command, {
      cwd: ctx.worktreePath,
      sessionKey: ctx.chatId,
      timeoutMs: input.timeoutSeconds * 1000,
    });
    return JSON.stringify({
      exitCode: r.timedOut ? 'timeout' : r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  },
};

export function registerCommandTools(): void {
  registerTool(runCommandTool);
}
