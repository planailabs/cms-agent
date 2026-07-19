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
    exclude: ['**/node_modules/**', 'chat/**', 'examples/**', 'proxy/**', 'dist/**', 'plugins/**'],
  },
});
