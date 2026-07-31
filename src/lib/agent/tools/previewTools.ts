/**
 * restart_preview — bounce the dev server behind this chat's preview and
 * report what the site answers afterwards.
 *
 * The agent needs this for the cases a file edit cannot fix: a dev server that
 * stopped recompiling, one still holding a dependency the agent just replaced,
 * or one that died while the automatism's site check was failing. Restarting
 * and re-probing in one call is deliberate — a restart whose outcome nobody
 * looked at is how a chat ends up insisting the site is fine.
 */
import { z } from 'zod';
import { previewLogs, stopInstance } from '@/lib/preview/manager';
import { chatPreviewRoutes, checkSiteHealth, describeIssues, hasErrors } from '@/lib/site/health';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

const restartPreviewTool: ToolDef = {
  name: 'restart_preview',
  description:
    "Restart the development server behind this chat's preview and check whether the " +
    'site renders afterwards. Use it when the preview is stuck, stale, or was never ' +
    'able to start — not for ordinary content changes, which the dev server picks up ' +
    'by itself.',
  schema: z.object({
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe('Why a restart is needed — shown in the server log, one short sentence'),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment'],
  async execute(input, ctx) {
    console.log(`[preview] chat=${ctx.chatId} agent restart of ${ctx.branchName}: ${input.reason}`);
    await stopInstance(ctx.branchName);
    // checkSiteHealth starts it again — a stopped server is the first thing it
    // reports on, so the restart and the verdict are one round trip.
    const issues = await checkSiteHealth({
      branch: ctx.branchName,
      worktree: ctx.worktreePath,
      routes: await chatPreviewRoutes(ctx.chatId),
    });
    return JSON.stringify(
      hasErrors(issues)
        ? {
            restarted: true,
            healthy: false,
            errors: describeIssues(issues),
            next: 'preview_logs shows what the development server printed while failing.',
          }
        : { restarted: true, healthy: true },
    );
  },
};

/**
 * The dev server says why it is unhappy in its own output — a stack trace, a
 * failed transform, a port already taken — and none of that reaches the page
 * the agent can fetch. The manager keeps a rolling buffer per branch that
 * outlives the process, so this works on a server that already died.
 */
const previewLogsTool: ToolDef = {
  name: 'preview_logs',
  description:
    "Read the recent output of the development server behind this chat's preview " +
    '(stdout and stderr, oldest line first). Use it when a page fails to render, the ' +
    'preview will not start, or a restart did not help — it survives the process, so ' +
    'the last lines before a crash are still there.',
  schema: z.object({
    lines: z
      .number()
      .int()
      .min(1)
      .max(400)
      .optional()
      .describe('How many trailing lines to return (default 100)'),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment'],
  async execute(input, ctx) {
    const lines = previewLogs(ctx.branchName, input.lines ?? 100);
    return JSON.stringify(
      lines.length > 0
        ? { branch: ctx.branchName, lines }
        : {
            branch: ctx.branchName,
            lines: [],
            note: 'The development server for this branch has not produced any output in this server process — it may never have been started here. restart_preview starts it.',
          },
    );
  },
};

export function registerPreviewTools(): void {
  registerTool(restartPreviewTool);
  registerTool(previewLogsTool);
}
