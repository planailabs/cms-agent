/**
 * Site health at a checkpoint — "is the site broken right now?", asked at the
 * moments where something landed that nobody has looked at yet (after a sync
 * rebases the draft onto the target, and wherever else a caller adds it).
 *
 * Two sources, because a site breaks in two ways:
 *  - the dev server does not come up at all (a bad config, a missing
 *    dependency) — the preview manager already records that failure;
 *  - the dev server is up and answers a page with an error — only the backend
 *    knows what that looks like, so it is asked (SiteBackend.detectSiteErrors).
 *
 * The result is a ValidationIssue list, the same vocabulary the pre-commit and
 * pre-publish validators speak, so a caller can hand it to the agent unchanged.
 */
import { prisma } from '@/lib/db';
import { ensureInstance, getStartError } from '@/lib/preview/manager';
import { activeBackend } from '@/lib/site';
import { hasErrors, type ValidationIssue } from '@/lib/validate';

export { hasErrors };

/** Routes probed when the caller names none. */
const HOME = '/';
/** Probing every open tab of a busy chat would outlast the checkpoint. */
const MAX_ROUTES = 5;

export interface SiteHealthInput {
  /** Preview branch to check — a chat's work branch. */
  branch: string;
  worktree: string;
  /** Extra routes to probe beyond '/' (deduped and capped). */
  routes?: string[];
}

/**
 * Routes worth probing for a chat: whatever its editors have open, which is
 * exactly what they will look at next. '/' is always included.
 */
export async function chatPreviewRoutes(chatId: string): Promise<string[]> {
  const rows = await prisma.chatTabs.findMany({ where: { chatId }, select: { tabs: true } });
  const routes = rows.flatMap((r) =>
    Array.isArray(r.tabs) ? (r.tabs as unknown[]).filter((t): t is string => typeof t === 'string') : [],
  );
  return [...new Set([HOME, ...routes])].slice(0, MAX_ROUTES);
}

export async function checkSiteHealth(input: SiteHealthInput): Promise<ValidationIssue[]> {
  const routes = [...new Set([HOME, ...(input.routes ?? [])])].slice(0, MAX_ROUTES);

  // Starting it IS the first half of the check: a dev server that refuses to
  // boot is the loudest possible site error, and the probe below needs a
  // running one anyway.
  let baseUrl: string;
  try {
    const instance = await ensureInstance(input.branch);
    baseUrl = `http://127.0.0.1:${instance.port}`;
  } catch (err) {
    const recorded = getStartError(input.branch);
    return [
      {
        validator: 'preview-start',
        severity: 'error',
        failureClass: 'AGENT_FIXABLE',
        message:
          `The preview development server for ${input.branch} does not start: ` +
          (recorded?.message ?? (err instanceof Error ? err.message : String(err))),
      },
    ];
  }

  const backend = activeBackend();
  if (!backend.detectSiteErrors) return [];
  try {
    return await backend.detectSiteErrors({ baseUrl, routes, worktree: input.worktree });
  } catch (err) {
    // The detector itself failing is an infrastructure problem, not a site
    // one — report it rather than passing the site as healthy.
    return [
      {
        validator: `${backend.id}-detect`,
        severity: 'error',
        failureClass: 'RETRYABLE_INFRA',
        message: `Checking the site for errors failed: ${err instanceof Error ? err.message : err}`,
      },
    ];
  }
}

/** One text block for the chat: what is broken, in the order found. */
export const describeIssues = (issues: ValidationIssue[]): string =>
  issues.map((i) => `[${i.validator}] ${i.message}`).join('\n\n');
