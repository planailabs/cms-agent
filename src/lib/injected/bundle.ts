/**
 * esbuild bundler for the injected-agent entries. Used by the prerendered
 * endpoints /injected-cms-agent.js and /injected-agent-module.js: at
 * `astro build` time the endpoints run once and ship as static files; in dev
 * they bundle per request (esbuild is fast, and dev must pick up edits to
 * files Vite's module graph doesn't track through this API).
 *
 * Because entries are real bundles, injected code may use imports freely —
 * the old "self-contained function" contract is gone.
 */
import { build } from 'esbuild';
import path from 'node:path';

const ENTRIES = {
  /** The engine script the proxy injects into preview pages (runs on load). */
  bootstrap: 'src/injected/bootstrap.ts',
  /**
   * The initial module the workspace pushes into the engine. Bundled with a
   * globalName so the engine can extract the default-export factory after
   * evaluating the text in a function scope (no page-global pollution).
   */
  module: 'src/injected/module/index.ts',
} as const;

export type InjectedEntry = keyof typeof ENTRIES;

export const MODULE_GLOBAL = '__cmsAgentModule';

const cache = new Map<InjectedEntry, string>();

export async function bundleInjected(entry: InjectedEntry): Promise<string> {
  const cached = cache.get(entry);
  if (cached && !import.meta.env.DEV) return cached;

  const result = await build({
    // cwd is the project root for astro dev, astro build, and vitest alike
    entryPoints: [path.resolve(process.cwd(), ENTRIES[entry])],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: entry === 'module' ? MODULE_GLOBAL : undefined,
    platform: 'browser',
    target: 'es2020',
    legalComments: 'none',
  });
  const source = result.outputFiles[0].text;
  cache.set(entry, source);
  return source;
}
