/**
 * Derive a SQLite variant of prisma/schema.prisma and push it into a throwaway
 * file DB so `pnpm test` needs no running services (see docs/setup.md).
 *
 * - writes prisma/schema.test.prisma (provider swapped, client output moved)
 * - writes prisma.test.config.mjs (Prisma 7 config pointing at the test schema)
 * - `prisma db push` into .test-tmp/test.db (recreated each run)
 * - generates a sqlite client into prisma/test-client
 * - the app picks the DB up via CMS_TEST_DB (see src/lib/db.ts); vitest
 *   setup sets that variable (test/setupVitest.ts)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(root, 'prisma', 'schema.prisma');
const testSchemaPath = path.join(root, 'prisma', 'schema.test.prisma');
const testConfigPath = path.join(root, 'prisma.test.config.mjs');
const tmpDir = path.join(root, '.test-tmp');
const dbPath = path.join(tmpDir, 'test.db');
const dbUrl = 'file:' + dbPath;

if (!process.env.PRISMA_SCHEMA_ENGINE_BINARY) {
  console.error(
    'prepare-test-db: Prisma engine missing; run through `nix develop --command pnpm test` (downloads are disabled)',
  );
  process.exit(1);
}

const source = fs.readFileSync(schemaPath, 'utf8');

// Swap datasource to sqlite and give the test client its own output so it
// doesn't clobber the postgres client.
const testSchema = source
  .replace(/datasource db \{[^}]*\}/, `datasource db {\n  provider = "sqlite"\n}`)
  .replace(
    /generator client \{[^}]*\}/,
    `generator client {\n  provider     = "prisma-client"\n  output       = "./test-client"\n  moduleFormat = "esm"\n}`,
  );

if (!testSchema.includes('provider = "sqlite"') || !testSchema.includes('test-client')) {
  console.error('prepare-test-db: failed to derive test schema');
  process.exit(1);
}

fs.writeFileSync(testSchemaPath, testSchema);

fs.writeFileSync(
  testConfigPath,
  `import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.test.prisma',
  datasource: { url: ${JSON.stringify(dbUrl)} },
});
`,
);

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

const runPrisma = (args) =>
  execFileSync('pnpm', ['exec', 'prisma', ...args, '--config', testConfigPath], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CMS_TEST_DB: dbUrl },
    shell: process.platform === 'win32',
  });

runPrisma(['db', 'push']);
runPrisma(['generate']);

fs.writeFileSync(path.join(tmpDir, 'db-url'), dbUrl);
console.log(`prepare-test-db: throwaway SQLite ready at ${dbUrl}`);
