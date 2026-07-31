/**
 * Astro site backend — verbatim extraction of the previously hardcoded
 * behavior: `npx astro dev|build` defaults, injected route-graph integration,
 * dist/ output, src/pages + src/content conventions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';
import {
  ASTRO_CONFIGS,
  prepareRouteGraphConfig,
  readRouteGraph,
} from '@/lib/preview/routeGraph';
import type { ValidationIssue } from '@/lib/validate';
import type { SiteBackend } from './backend';

/** A hung route must not hold up the checkpoint that probes it. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * `fetch failed` is what undici says for every transport problem — refused,
 * reset, DNS, TLS — and it is the one thing a person debugging this must not
 * be told. The cause chain carries the syscall and the code; say those.
 */
export function transportReason(err: unknown): string {
  const describe = (e: Error): string => {
    const x = e as Error & { code?: string; syscall?: string; address?: string; port?: number };
    const detail = [x.code, x.syscall, x.address ? `${x.address}${x.port ? `:${x.port}` : ''}` : null]
      .filter(Boolean)
      .join(' ');
    return detail ? `${e.message} (${detail})` : e.message;
  };

  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const e = current;
    parts.push(describe(e));
    // Node reports "connect failed" per address family in an AggregateError;
    // the codes live on its members, and the codes are the whole point.
    const nested = (e as unknown as { errors?: unknown }).errors;
    if (Array.isArray(nested) && nested.length > 0) {
      parts.push(nested.filter((n): n is Error => n instanceof Error).map(describe).join(', '));
      break;
    }
    current = (e as { cause?: unknown }).cause;
  }
  return parts.filter(Boolean).join(' ← ') || String(err);
}

/**
 * One retry on a transport error: a dev server that has just answered its
 * first request can still drop the next connection while Vite finishes
 * warming, and a checkpoint that pauses a sync over that would be a false
 * alarm the user has to clear by hand.
 */
async function probe(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (first) {
    await new Promise((r) => setTimeout(r, 750));
    try {
      return await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch {
      throw first; // the first failure is the one worth reporting
    }
  }
}

/**
 * The readable part of Astro's dev error page. It renders the error as HTML
 * (title, message, file, stack) — the agent needs the words, not the markup,
 * and the first lines carry the message and the file it happened in.
 */
export function astroErrorText(html: string): string {
  const text = html
    // <script>/<style> bodies are page machinery, never the error
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|pre|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text ? text.slice(0, 1200) : '(the dev server returned no readable error text)';
}

function pkgDependsOnAstro(repoRoot: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return Boolean(pkg?.dependencies?.astro || pkg?.devDependencies?.astro);
  } catch {
    return false;
  }
}

export const astroBackend: SiteBackend = {
  id: 'astro',
  promptLabel: 'an Astro website',

  detect: (repoRoot) =>
    ASTRO_CONFIGS.some((name) => fs.existsSync(path.join(repoRoot, name))) ||
    pkgDependsOnAstro(repoRoot),

  devCommand({ worktree, port, host, allowedHost }) {
    // Astro persists its dev PID in the worktree. Preview processes run in
    // separate PID namespaces, where the Astro child commonly gets the same
    // small PID after a container restart; a stale record can therefore look
    // alive and block startup forever — remove Astro's session record.
    fs.rmSync(path.join(worktree, '.astro', 'dev.json'), { force: true });
    const graphConfig = prepareRouteGraphConfig(worktree);
    // REPO_DEV_COMMAND is split on whitespace (document: no shell quoting)
    const base = (env().REPO_DEV_COMMAND ?? 'npx astro dev').split(/\s+/);
    return {
      argv: [...base, '--config', graphConfig, '--port', String(port), '--host', host],
      // The proxy preserves the public Host header (<branch>.<BASE_DOMAIN>),
      // which Vite's host check would otherwise block.
      extraEnv: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: allowedHost },
    };
  },

  buildCommand: () => env().REPO_BUILD_COMMAND ?? 'npx astro build',

  resolveDist(buildDir) {
    const dist = path.join(buildDir, 'dist');
    if (!fs.existsSync(dist)) throw new Error('Build produced no dist/ directory');
    return dist;
  },

  pageRoute(file) {
    const rel = file.replace(/^src\/pages\//, '');
    if (rel === file) return null;
    const ext = path.extname(rel);
    if (!['.astro', '.md', '.mdx', '.html'].includes(ext)) return null;
    let route = rel.slice(0, -ext.length);
    if (route === 'index') return { route: '/', dynamic: false };
    route = route.replace(/\/index$/, '');
    // dynamic ([param]) routes need a ROUTE_MAPPINGS entry for the diff
    return { route: `/${route}/`, dynamic: route.includes('[') };
  },

  isSiteContent: (file) => file.startsWith('src/pages/') || file.startsWith('src/content/'),

  routeGraph: { read: readRouteGraph },

  async detectSiteErrors({ baseUrl, routes }) {
    const issues: ValidationIssue[] = [];
    for (const route of routes) {
      const url = `${baseUrl}${route.startsWith('/') ? route : `/${route}`}`;
      let res: Response;
      try {
        res = await probe(url);
      } catch (err) {
        // Reaching here means the checker could not talk to the dev server at
        // all. That is usually the CHECKER's problem — the wrong address, a
        // connection dropped while the server was still coming up — and the
        // agent is the wrong audience for it, so the class says infrastructure
        // and the message carries what actually failed rather than undici's
        // opaque "fetch failed".
        issues.push({
          validator: 'astro-dev',
          severity: 'error',
          failureClass: 'RETRYABLE_INFRA',
          message: `${route} could not be requested at ${url}: ${transportReason(err)}`,
        });
        continue;
      }
      // 4xx is the site's own routing answer (a page that does not exist is
      // not a broken build); 5xx is Astro reporting that it cannot render.
      if (res.status < 500) continue;
      issues.push({
        validator: 'astro-dev',
        severity: 'error',
        failureClass: 'AGENT_FIXABLE',
        message: `${route} fails to render (HTTP ${res.status}): ${astroErrorText(await res.text().catch(() => ''))}`,
      });
    }
    return issues;
  },

  extraExcludes: ['.astro/', 'dist/'],
};
