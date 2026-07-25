/**
 * Map changed repo files to site routes for the visual diff (plan §6).
 * Conventions: the active site backend's path rules (e.g. src/pages/** for
 * Astro); content collections via ROUTE_MAPPINGS ([{files: glob, route:
 * pattern-with-:slug}]); dynamic pages without a mapping are reported as
 * unresolved.
 */
import path from 'node:path';
import { env } from '@/lib/env';
import { activeBackend, type SiteBackend } from '@/lib/site';

export interface RouteMapping {
  files: string;
  route: string;
}

export interface ChangedPage {
  route: string;
  file: string;
}

export interface RouteResolution {
  pages: ChangedPage[];
  unresolved: string[];
}

/** Minimal glob → regex: ** crosses directories, * stays within one. */
export function globToRegExp(glob: string): RegExp {
  const DOUBLE_STAR = '\u0000';
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', DOUBLE_STAR)
    .replaceAll('*', '[^/]*')
    .replaceAll(DOUBLE_STAR, '.*');
  return new RegExp(`^${escaped}$`);
}

function slugFromFile(file: string): string {
  const base = path.basename(file);
  return base.slice(0, base.length - path.extname(base).length);
}

export function parseRouteMappings(raw: string | undefined): RouteMapping[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is RouteMapping => typeof m?.files === 'string' && typeof m?.route === 'string',
    );
  } catch {
    console.error('[diff] ROUTE_MAPPINGS is not valid JSON — ignoring');
    return [];
  }
}

/**
 * Resolve changed files to routes. `plannedUrls` (from the approved plan's
 * pages list) are always included — the agent knows derived pages the file
 * mapping can't see.
 */
export function resolveChangedPages(
  changedFiles: string[],
  plannedUrls: string[] = [],
  mappings: RouteMapping[] = parseRouteMappings(env().ROUTE_MAPPINGS),
  inferredPages: ChangedPage[] = [],
  backend: SiteBackend = activeBackend(),
): RouteResolution {
  const pages = new Map<string, ChangedPage>();
  const unresolved: string[] = [];

  for (const file of changedFiles) {
    let route: string | null = null;

    for (const mapping of mappings) {
      if (globToRegExp(mapping.files).test(file)) {
        route = mapping.route.replace(':slug', slugFromFile(file));
        if (!route.endsWith('/')) route += '/';
        break;
      }
    }

    if (!route) {
      const pr = backend.pageRoute(file);
      if (pr && !pr.dynamic) route = pr.route; // dynamic — needs a mapping
    }

    if (route) {
      if (!pages.has(route)) pages.set(route, { route, file });
    } else if (backend.isSiteContent(file)) {
      unresolved.push(file);
    }
    // Components and styles are resolved through the preview dependency graph;
    // plannedUrls remain the fallback for data-driven effects it cannot see.
  }

  for (const page of inferredPages) {
    if (!pages.has(page.route)) pages.set(page.route, page);
  }

  for (const url of plannedUrls) {
    try {
      let route = url.startsWith('http') ? new URL(url).pathname : url;
      if (!route.startsWith('/')) route = `/${route}`;
      if (!route.endsWith('/')) route += '/';
      if (!pages.has(route)) pages.set(route, { route, file: '(from plan)' });
    } catch {
      // ignore malformed planned urls
    }
  }

  return { pages: [...pages.values()], unresolved };
}
