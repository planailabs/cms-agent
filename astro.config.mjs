import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import node from '@astrojs/node';
import { simpleGit } from 'simple-git';

// Embedded next to the version in the header. The nix build sets it from the
// flake's self.shortRev (the store source has no .git); in dev we resolve it
// from the repo here.
if (!process.env.PUBLIC_GIT_COMMIT) {
  try {
    process.env.PUBLIC_GIT_COMMIT = (await simpleGit().revparse(['--short', 'HEAD'])).trim();
  } catch {
    /* no git available (e.g. sandboxed build without the env var) — omit */
  }
}

export default defineConfig({
  // Fully SSR app (auth middleware on every route) — never prerender.
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  vite: {
    envPrefix: ['VITE_', 'PUBLIC_'],
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve('./src'),
      },
    },
    server: {
      watch: {
        // Don't watch runtime state (sandbox extractions, worktrees, diffs,
        // routes) or the dev site copy — churn there must not reload the CMS.
        ignored: ['**/var/**', '**/local/**'],
      },
    },
  },
  devToolbar: {
    enabled: false,
  },
  // 'ignore': the API is called without trailing slashes throughout the UI;
  // 'always' (inherited from the reference app) 404s those routes in dev.
  trailingSlash: 'ignore',
});
