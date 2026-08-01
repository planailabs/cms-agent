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
import {
  chatPreviewRoutes,
  checkSiteHealth,
  describeIssues,
  hasErrors,
  lastSiteHealth,
} from '@/lib/site/health';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

const queueBackendErrorCheck = async (
  issues: Awaited<ReturnType<typeof checkSiteHealth>>,
  ctx: Parameters<NonNullable<ToolDef['execute']>>[1],
): Promise<void> => {
  if (
    ctx.chatKind !== 'workflow' ||
    !issues.some(
      (issue) =>
        issue.validator !== 'preview-start' &&
        issue.severity === 'error' &&
        issue.failureClass !== 'RETRYABLE_INFRA',
    )
  ) {
    return;
  }
  const { queueDetectedSiteCheck } = await import('@/lib/publish/publisher');
  void queueDetectedSiteCheck(ctx.chatId, ctx.userId);
};

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
    await queueBackendErrorCheck(issues, ctx);
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

/**
 * The failure record the checkpoints write (lib/site/health), in the same
 * shape whatever the site backend is. The agent is invoked on a paused sync
 * with the errors quoted in a chat message; this is the structured form of
 * that — which validator, which failure class, which routes were probed —
 * without re-reading prose, and it is how the agent confirms a fix rather
 * than announcing one.
 */
const siteStatusTool: ToolDef = {
  name: 'site_status',
  description:
    "Report whether this chat's draft site renders: the last recorded check " +
    '(what failed, which routes were probed, when), or a fresh one with ' +
    'recheck=true. Use it to confirm a fix before resuming a paused sync.',
  schema: z.object({
    recheck: z
      .boolean()
      .optional()
      .describe('Run the check again now instead of reporting the last result (default false)'),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment'],
  async execute(input, ctx) {
    if (input.recheck) {
      const issues = await checkSiteHealth({
        branch: ctx.branchName,
        worktree: ctx.worktreePath,
        routes: await chatPreviewRoutes(ctx.chatId),
      });
      await queueBackendErrorCheck(issues, ctx);
      return JSON.stringify({
        checked: 'just now',
        healthy: !hasErrors(issues),
        issues,
        ...(hasErrors(issues) ? { summary: describeIssues(issues) } : {}),
      });
    }
    const report = lastSiteHealth(ctx.branchName);
    if (!report) {
      return JSON.stringify({
        checked: null,
        note: 'The site has not been checked in this server process — call again with recheck=true.',
      });
    }
    await queueBackendErrorCheck(report.issues, ctx);
    return JSON.stringify({
      checkedSecondsAgo: Math.round((Date.now() - report.at) / 1000),
      routes: report.routes,
      healthy: !hasErrors(report.issues),
      issues: report.issues,
      ...(hasErrors(report.issues) ? { summary: describeIssues(report.issues) } : {}),
    });
  },
};

export function registerPreviewTools(): void {
  registerTool(restartPreviewTool);
  registerTool(previewLogsTool);
  registerTool(siteStatusTool);
}
