/**
 * SiteBackend port — adapters teach the CMS how the managed site repo is
 * developed, built and routed (dev server, build output, file→route mapping,
 * prompt framing). Registry mirrors src/lib/content/adapter.ts.
 */
import type { PreviewRouteGraph } from '@/lib/preview/routeGraph';
import type { ValidationIssue } from '@/lib/validate';

export interface DevCommand {
  /** Full argv (incl. port/host flags) for spawnSandboxed. */
  argv: string[];
  extraEnv?: Record<string, string>;
}

export interface SiteBackend {
  id: string; // 'astro' | 'static'
  /** Interpolated into system prompts: "an Astro website". */
  promptLabel: string;
  /** Optional conventions paragraph appended to the workflow prompt. */
  promptGuidance?: string;
  /** Does this backend match the repo? Checked in registration order. */
  detect(repoRoot: string): boolean;
  /**
   * Build the dev-server command for one branch worktree. Called once right
   * before spawn; MAY prepare files in the worktree (route-graph config,
   * stale session records).
   */
  devCommand(opts: {
    worktree: string;
    port: number;
    host: string;
    allowedHost: string;
  }): DevCommand;
  /** Shell line for the production build, or null = no build step. */
  buildCommand(): string | null;
  /** Dist dir inside a clean checkout after buildCommand ran; throws when missing. */
  resolveDist(buildDir: string): string;
  /** Path-convention route for one repo file; null = not a page. */
  pageRoute(file: string): { route: string; dynamic: boolean } | null;
  /** Files in the "site content" universe (list_pages, diff unresolved bucket). */
  isSiteContent(file: string): boolean;
  /** Optional preview dependency-graph capability (visual diff precision). */
  routeGraph?: { read(worktree: string): PreviewRouteGraph | null };
  /**
   * Ask the running preview whether the site is currently broken.
   *
   * Backend-specific because "broken" is: Astro answers a compile error with
   * a 500 and its own error page, a plain static server answers 404s and
   * nothing else. Called at checkpoints where a change landed that nobody
   * looked at yet (after a sync, before a publish) — see lib/site/health.ts.
   * Omitted: the backend has no runtime errors of its own to report.
   */
  detectSiteErrors?(opts: {
    /** Origin of the running preview, e.g. http://127.0.0.1:41234 (no proxy). */
    baseUrl: string;
    /** Routes to probe; the caller decides how many are worth the time. */
    routes: string[];
    worktree: string;
  }): Promise<ValidationIssue[]>;
  /** Repo-local git excludes beyond the common set. */
  extraExcludes: string[];
}

const registry = new Map<string, SiteBackend>();

/** Registration order doubles as detection order — register catch-alls last. */
export function registerSiteBackend(backend: SiteBackend): void {
  registry.set(backend.id, backend);
}

export function getSiteBackends(): SiteBackend[] {
  return [...registry.values()];
}

export function getSiteBackend(id: string): SiteBackend | undefined {
  return registry.get(id);
}
