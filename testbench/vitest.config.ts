/**
 * Testbench runner config — scenarios talk to a REAL production-build server
 * booted by launcher.mjs (which sets BENCH_* env). No setupVitest fake env,
 * long timeouts (real model turns), strictly sequential (scenarios share one
 * server and 03's journey feeds 04/05).
 */
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import path from 'node:path';

/** The default sequencer reorders by cached duration — scenarios are data-
 *  dependent (03's journey feeds 04/05/06), so pin filename order. */
class FilenameOrder extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

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
    sequence: { concurrent: false, sequencer: FilenameOrder },
  },
});
