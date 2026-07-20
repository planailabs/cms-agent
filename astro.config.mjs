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

// virtual:mcp-bridge — the sandboxed MCP bridge (src/lib/agent/mcp/
// bridgeEntry.ts) esbuild-bundled to one self-contained file and embedded as
// a string, so the server build carries it without shipping src/. vitest
// lacks this plugin; custom.ts falls back to bundling from src on the fly.
const mcpBridge = () => ({
  name: 'mcp-bridge',
  resolveId(id) {
    if (id === 'virtual:mcp-bridge') return '\0virtual:mcp-bridge';
  },
  async load(id) {
    if (id !== '\0virtual:mcp-bridge') return;
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [path.resolve('./src/lib/agent/mcp/bridgeEntry.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node26',
      // Prefer ESM builds: UMD entries (jsonc-parser) hide requires from
      // esbuild's static analysis and break at runtime in the jail.
      mainFields: ['module', 'main'],
      legalComments: 'none',
    });
    return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
  },
});

export default defineConfig({
  // Fully SSR app (auth middleware on every route) — never prerender.
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  vite: {
    envPrefix: ['VITE_', 'PUBLIC_'],
    plugins: [tailwindcss(), mcpBridge()],
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
