import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    setupFiles: ['./test/setupVitest.ts'],
    testTimeout: 30_000,
    // chat/ is the reference app we extracted from — its suite is not ours;
    // examples/ are target-site fixtures; plugins/ are vendored submodules
    // with their own (foreign) test suites.
    // testbench/ has its own config + a launcher-booted server; without the
    // exclude the default include would collect it under the fake test env.
    exclude: [
      '**/node_modules/**',
      'chat/**',
      'examples/**',
      'proxy/**',
      'dist/**',
      'plugins/**',
      'testbench/**',
    ],
  },
});
