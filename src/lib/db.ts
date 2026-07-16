/**
 * Prisma client singleton (Prisma 7, driver adapters — no Rust engine).
 *
 * Production: PostgreSQL via @prisma/adapter-pg.
 * Tests: scripts/prepare-test-db.mjs derives a SQLite schema and generates a
 * dedicated client into prisma/test-client; CMS_TEST_DB selects it. Models
 * are identical, so the postgres client's types stay authoritative.
 */
import type { PrismaClient } from '@/generated/prisma/client';

type PrismaModule = typeof import('@/generated/prisma/client');

const testClientPath: string = '../../prisma/test-client/client.ts';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaDbNull?: unknown;
};

async function createClient(): Promise<PrismaClient> {
  const testDbUrl = process.env.CMS_TEST_DB;
  if (testDbUrl) {
    const [{ PrismaBetterSqlite3 }, mod] = await Promise.all([
      import('@prisma/adapter-better-sqlite3'),
      import(/* @vite-ignore */ testClientPath) as Promise<PrismaModule>,
    ]);
    const adapter = new PrismaBetterSqlite3({ url: testDbUrl });
    globalForPrisma.prismaDbNull = mod.Prisma.DbNull;
    return new mod.PrismaClient({ adapter }) as PrismaClient;
  }
  const [{ PrismaPg }, mod] = await Promise.all([
    import('@prisma/adapter-pg'),
    import('@/generated/prisma/client'),
  ]);
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  globalForPrisma.prismaDbNull = mod.Prisma.DbNull;
  return new mod.PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? (await createClient());

/**
 * Json-null sentinel of the ACTIVE generated client (sentinels are per-client
 * instances, so they must come from the same module as the client in use).
 */
export const dbNull = globalForPrisma.prismaDbNull as never;

if (import.meta.env?.DEV) globalForPrisma.prisma = prisma;
