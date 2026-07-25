/**
 * Static-HTML site backend — no framework, no build step: files map 1:1 to
 * URLs and previews are served straight from the worktree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';
import type { SiteBackend } from './backend';

export const staticBackend: SiteBackend = {
  id: 'static',
  promptLabel: 'a static HTML website',
  promptGuidance:
    'This site is plain static HTML: files map 1:1 to URLs (about.html → /about.html, ' +
    'guides/index.html → /guides/). There is no build step, framework, or component system — ' +
    'edit the HTML/CSS/JS files directly, and keep shared markup (nav, footer) consistent ' +
    'across pages when changing it.',

  // Catch-all fallback — registered last, matches any repo.
  detect: () => true,

  devCommand({ port, host }) {
    // python3 ships in every sandbox env (flake.nix sandboxCommonPkgs); the
    // spawn cwd is the worktree. ponytail: no live-reload — previews reflect
    // saves on reload, which is how the visual diff consumes them anyway.
    return {
      argv: ['python3', '-m', 'http.server', String(port), '--bind', host, '--directory', '.'],
    };
  },

  // Escape hatch: an explicit REPO_BUILD_COMMAND is still honored.
  buildCommand: () => env().REPO_BUILD_COMMAND ?? null,

  resolveDist(buildDir) {
    if (env().REPO_BUILD_COMMAND) {
      const dist = path.join(buildDir, 'dist');
      if (!fs.existsSync(dist)) throw new Error('Build produced no dist/ directory');
      return dist;
    }
    return buildDir; // no build: the clean checkout IS the dist
  },

  pageRoute(file) {
    if (!file.endsWith('.html')) return null;
    if (file === 'index.html') return { route: '/', dynamic: false };
    if (file.endsWith('/index.html')) {
      return { route: `/${file.slice(0, -'index.html'.length)}`, dynamic: false };
    }
    return { route: `/${file}`, dynamic: false };
  },

  isSiteContent: (file) => file.endsWith('.html'),

  extraExcludes: [],
};
