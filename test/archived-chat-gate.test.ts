/**
 * POST /api/chat/message — archived chats accept no messages (any turn type),
 * unknown chats 404, live chats still take turns.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agent/handler', () => ({ handleChatMessage: vi.fn(async () => {}) }));
vi.mock('@/lib/autonomy', () => ({ maybeAutoApprovePlan: vi.fn(async () => {}) }));

import { prisma } from '@/lib/db';
import { POST } from '@/pages/api/chat/message';

const ACTOR = { id: 'archive-gate-user', name: 'Gate Tester' };

const post = (chatId: string, type = 'message') =>
  POST({
    request: new Request('http://localhost/api/chat/message', {
      method: 'POST',
      body: JSON.stringify({ chatId, type, text: 'hello' }),
    }),
    locals: { user: { id: ACTOR.id, language: 'en' } },
  } as never);

let branchId: string;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  const u = await prisma.user.create({
    data: { id: ACTOR.id, name: ACTOR.name, email: 'archive-gate@example.com' },
  });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: u.id },
  });
  branchId = branch.id;
});

describe('archived chat message gate', () => {
  it('rejects every turn type on an archived chat', async () => {
    const chat = await prisma.chat.create({
      data: {
        branchId,
        workBranch: 'c-archgate1',
        createdById: ACTOR.id,
        title: 'Archived',
        archivedAt: new Date(),
      },
    });
    for (const type of ['message', 'answer', 'continue']) {
      const res = await post(chat.id, type);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/archived/);
    }
  });

  it('404s unknown chats and still accepts live ones', async () => {
    expect((await post('no-such-chat')).status).toBe(404);

    const chat = await prisma.chat.create({
      data: { branchId, workBranch: 'c-archgate2', createdById: ACTOR.id, title: 'Live' },
    });
    expect((await post(chat.id)).status).toBe(202);
  });
});
