/**
 * Vitest setup — wires the throwaway SQLite DB created by
 * scripts/prepare-test-db.mjs (run automatically by `pnpm test`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Complete env defaults so env() validates in every test; individual tests
// override what they exercise (and call resetEnvCache()).
const TEST_ENV_DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  BETTER_AUTH_URL: 'http://localhost:4321',
  OIDC_ISSUER: 'https://idp.example.com',
  OIDC_CLIENT_ID: 'cms',
  OIDC_CLIENT_SECRET: 'secret',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_MODEL: 'gpt-test',
  BASE_DOMAIN: 'cms.example.com',
  REPO_PATH: path.join(os.tmpdir(), 'cms-agent-unset-repo'),
  VAR_DIR: path.join(os.tmpdir(), 'cms-agent-unset-var'),
};
for (const [k, v] of Object.entries(TEST_ENV_DEFAULTS)) {
  if (!process.env[k]) process.env[k] = v;
}

const dbUrlFile = path.resolve(__dirname, '..', '.test-tmp', 'db-url');

if (fs.existsSync(dbUrlFile)) {
  process.env.CMS_TEST_DB = fs.readFileSync(dbUrlFile, 'utf8').trim();
} else {
  throw new Error('Test DB missing — run `node scripts/prepare-test-db.mjs` first (pnpm test does this).');
}
