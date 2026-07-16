import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { DEV_USERS, getDevUser, seedDevUsers } from '@/lib/devAuth';

describe('SKIP_AUTH dev mode', () => {
  beforeAll(async () => {
    await seedDevUsers();
  });

  it('seeds admin@localhost + two editors', async () => {
    const users = await prisma.user.findMany({ where: { id: { in: DEV_USERS.map((u) => u.id) } } });
    expect(users).toHaveLength(3);
    expect(users.find((u) => u.email === 'admin@localhost')?.role).toBe('admin');
    expect(users.find((u) => u.email === 'user@localhost')?.role).toBe('editor');
    expect(users.find((u) => u.email === 'user2@localhost')?.role).toBe('editor');
  });

  it('defaults to admin and honors valid impersonation only', async () => {
    expect((await getDevUser()).email).toBe('admin@localhost');
    expect((await getDevUser('user2@localhost')).email).toBe('user2@localhost');
    // unknown identity falls back to admin instead of erroring
    expect((await getDevUser('mallory@evil.com')).email).toBe('admin@localhost');
  });
});
