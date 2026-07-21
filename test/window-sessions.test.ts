/**
 * Window-sessions API: upsert/list/fetch/delete, strict ownership, and the
 * per-user prune cap.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { GET as list, PUT as put } from '@/pages/api/window-sessions/index';
import { GET as getOne, DELETE as del } from '@/pages/api/window-sessions/[id]';

const U1 = 'wsn-user-1';
const U2 = 'wsn-user-2';

const asUser = (userId: string) => ({ user: { id: userId } });

const putSession = (userId: string, id: string, label = 'w', state: object = { v: 1 }) =>
  put({
    request: new Request('http://x/api/window-sessions', {
      method: 'PUT',
      body: JSON.stringify({ id, label, state }),
    }),
    locals: asUser(userId),
  } as never);

beforeAll(async () => {
  await prisma.windowSession.deleteMany({ where: { userId: { in: [U1, U2] } } });
  for (const [id, email] of [
    [U1, 'wsn1@example.com'],
    [U2, 'wsn2@example.com'],
  ] as const) {
    await prisma.user.upsert({
      where: { id },
      create: { id, name: id, email },
      update: {},
    });
  }
});

describe('window sessions API', () => {
  it('upserts, lists (newest first), fetches and deletes own sessions', async () => {
    const id = randomUUID();
    expect((await putSession(U1, id, 'My window', { v: 1, chatId: 'c1' })).status).toBe(200);
    // update in place
    expect((await putSession(U1, id, 'Renamed', { v: 1, chatId: 'c2' })).status).toBe(200);

    const listed = (await (await list({ locals: asUser(U1) } as never)).json()) as {
      sessions: Array<{ id: string; label: string }>;
    };
    expect(listed.sessions.some((s) => s.id === id && s.label === 'Renamed')).toBe(true);

    const one = (await (
      await getOne({ params: { id }, locals: asUser(U1) } as never)
    ).json()) as { state: { chatId: string } };
    expect(one.state.chatId).toBe('c2');

    const removed = await del({ params: { id }, locals: asUser(U1) } as never);
    expect(((await removed.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('enforces ownership across users', async () => {
    const id = randomUUID();
    await putSession(U1, id);
    // U2 cannot read, overwrite, or delete U1's session
    expect((await getOne({ params: { id }, locals: asUser(U2) } as never)).status).toBe(404);
    expect((await putSession(U2, id)).status).toBe(403);
    const res = await del({ params: { id }, locals: asUser(U2) } as never);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(await prisma.windowSession.findUnique({ where: { id } })).not.toBeNull();
  });

  it('prunes beyond the newest 12 per user', async () => {
    for (let i = 0; i < 14; i++) await putSession(U2, randomUUID(), `w${i}`);
    const count = await prisma.windowSession.count({ where: { userId: U2 } });
    expect(count).toBeLessThanOrEqual(12);
  });

  it('rejects invalid ids and unauthenticated calls', async () => {
    expect((await putSession(U1, 'not-a-uuid')).status).toBe(400);
    expect((await list({ locals: {} } as never)).status).toBe(401);
  });
});
