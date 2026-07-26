/**
 * Bench run contract — the launcher writes bench-env.json (full server env +
 * ports + workspace paths) and points the suite at it via BENCH_ENV_FILE /
 * BENCH_BASE_URL / BENCH_RESULTS_DIR.
 */
import fs from 'node:fs';

export interface BenchRun {
  /** Public base URL (through the native proxy). */
  baseUrl: string;
  /** Proxy port — preview hosts are `<branch>.localhost:<proxyPort>`. */
  proxyPort: number;
  /** The full env the server was booted with (incl. real AI keys). */
  env: Record<string, string>;
  /** Throwaway workspace: site repo, bare deploy remote, VAR_DIR. */
  work: string;
  sitePath: string;
  deployRemotePath: string;
  resultsDir: string;
}

let cached: BenchRun | null = null;

export function benchRun(): BenchRun {
  if (cached) return cached;
  const file = process.env.BENCH_ENV_FILE;
  if (!file) {
    throw new Error('BENCH_ENV_FILE unset — run scenarios via `pnpm bench`, not vitest directly');
  }
  const blob = JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<BenchRun, 'resultsDir'>;
  cached = { ...blob, resultsDir: process.env.BENCH_RESULTS_DIR ?? blob.work };
  fs.mkdirSync(cached.resultsDir, { recursive: true });
  return cached;
}

export const previewUrl = (branch: string, route = '/'): string => {
  const { proxyPort } = benchRun();
  return `http://${branch}.localhost:${proxyPort}${route}`;
};
