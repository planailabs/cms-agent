/**
 * Vitest setup — wires the throwaway SQLite DB created by
 * scripts/prepare-test-db.mjs (run automatically by `pnpm test`).
 */
import fs from 'node:fs';
import path from 'node:path';

const dbUrlFile = path.resolve(__dirname, '..', '.test-tmp', 'db-url');

if (fs.existsSync(dbUrlFile)) {
  process.env.CMS_TEST_DB = fs.readFileSync(dbUrlFile, 'utf8').trim();
} else {
  throw new Error('Test DB missing — run `node scripts/prepare-test-db.mjs` first (pnpm test does this).');
}
