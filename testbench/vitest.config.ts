/**
 * Testbench runner config — scenarios talk to a REAL production-build server
 * booted by launcher.mjs (which sets BENCH_* env). No setupVitest fake env,
 * long timeouts (real model turns), strictly sequential (scenarios share one
 * server and 03's journey feeds 04/05).
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
  test: {
    include: ['testbench/scenarios/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
