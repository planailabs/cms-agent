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

/**
 * The last verdict per branch, backend-agnostic: whoever checked (the sync
 * checkpoint, the agent's own tool) leaves the result here in one vocabulary,
 * so the agent can ask what is broken without re-running a check — and
 * without parsing it back out of the chat transcript, which is prose.
 *
 * In memory with the preview logs it explains: both describe a dev server
 * this process is running, and both are worthless after a restart.
 */
const g = globalThis as unknown as { __siteHealth?: Map<string, SiteHealthReport> };
const reports = (): Map<string, SiteHealthReport> => (g.__siteHealth ??= new Map());

export interface SiteHealthReport {
  branch: string;
  /** Epoch ms of the check. */
  at: number;
  issues: ValidationIssue[];
  /** Routes the check actually probed. */
  routes: string[];
}

export const lastSiteHealth = (branch: string): SiteHealthReport | null =>
  reports().get(branch) ?? null;

export const clearSiteHealth = (branch: string): void => {
  reports().delete(branch);
};

function record(branch: string, routes: string[], issues: ValidationIssue[]): ValidationIssue[] {
  reports().set(branch, { branch, at: Date.now(), issues, routes });
  return issues;
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
    return record(input.branch, routes, [
      {
        validator: 'preview-start',
        severity: 'error',
        failureClass: 'AGENT_FIXABLE',
        message:
          `The preview development server for ${input.branch} does not start: ` +
          (recorded?.message ?? (err instanceof Error ? err.message : String(err))),
      },
    ]);
  }

  const backend = activeBackend();
  if (!backend.detectSiteErrors) return record(input.branch, routes, []);
  try {
    return record(
      input.branch,
      routes,
      await backend.detectSiteErrors({ baseUrl, routes, worktree: input.worktree }),
    );
  } catch (err) {
    // The detector itself failing is an infrastructure problem, not a site
    // one — report it rather than passing the site as healthy.
    return record(input.branch, routes, [
      {
        validator: `${backend.id}-detect`,
        severity: 'error',
        failureClass: 'RETRYABLE_INFRA',
        message: `Checking the site for errors failed: ${err instanceof Error ? err.message : err}`,
      },
    ]);
  }
}

/** One text block for the chat: what is broken, in the order found. */
export const describeIssues = (issues: ValidationIssue[]): string =>
  issues.map((i) => `[${i.validator}] ${i.message}`).join('\n\n');
