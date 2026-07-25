/**
 * Active site backend: SITE_BACKEND env override, else first detect() match
 * against REPO_PATH (static is the registered catch-all). Detection runs
 * against the main repo, not per-worktree — a branch adding/removing
 * astro.config does not flip the backend mid-flight.
 */
import path from 'node:path';
import { env } from '@/lib/env';
import {
  getSiteBackend,
  getSiteBackends,
  registerSiteBackend,
  type SiteBackend,
} from './backend';
import { astroBackend } from './astro';
import { staticBackend } from './static';

export type { DevCommand, SiteBackend } from './backend';
export { getSiteBackend, getSiteBackends, registerSiteBackend };

let builtinsRegistered = false;
function ensureBuiltins(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  registerSiteBackend(astroBackend); // order matters: static detect() is the catch-all
  registerSiteBackend(staticBackend);
}

let active: { repo: string; backend: SiteBackend } | null = null;

export function activeBackend(): SiteBackend {
  const repo = path.resolve(env().REPO_PATH);
  if (active?.repo === repo) return active.backend;
  ensureBuiltins();
  const override = env().SITE_BACKEND;
  let backend: SiteBackend;
  if (override) {
    const found = getSiteBackend(override);
    if (!found) {
      const ids = getSiteBackends().map((b) => b.id).join(', ');
      throw new Error(`SITE_BACKEND=${override} is not a registered site backend (have: ${ids})`);
    }
    backend = found;
  } else {
    backend = getSiteBackends().find((b) => b.detect(repo))!; // static always matches
  }
  console.log(`[site] backend for ${repo}: ${backend.id}`);
  active = { repo, backend };
  return backend;
}

/** Test hook — mirror resetEnvCache(). */
export function resetActiveBackend(): void {
  active = null;
}
