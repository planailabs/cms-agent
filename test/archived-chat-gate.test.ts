/**
 * POST /api/chat/message — archived chats accept no messages (any turn type),
 * unknown chats 404, live chats still take turns.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agent/handler', () => ({ handleChatMessage: vi.fn(async () => {}) }));
vi.mock('@/lib/autonomy', () => ({ maybeAutoApprovePlan: vi.fn(async () => {}) }));
vi.mock('@/lib/agent/workflow', () => ({
  requestChanges: vi.fn(async () => {}),
  WorkflowError: class extends Error {
    status = 409;
  },
}));

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
  await prisma.chat.deleteMany({
    where: { workBranch: { in: ['c-archgate1', 'c-archgate2', 'c-archgate3'] } },
  });
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

  it('routes an answer to a pending propose_plan as a change request', async () => {
    await prisma.chat.deleteMany({ where: { workBranch: 'c-archgate3' } });
    const chat = await prisma.chat.create({
      data: {
        branchId,
        workBranch: 'c-archgate3',
        createdById: ACTOR.id,
        title: 'Planned',
        turnPhase: 'waiting_for_answer',
        pendingQuestion: { toolName: 'propose_plan', input: { summary: 'do things' } },
      },
    });
    const res = await post(chat.id, 'answer');
    expect(res.status).toBe(202);
    expect(((await res.json()) as { routedTo?: string }).routedTo).toBe('request-changes');
    const { requestChanges } = await import('@/lib/agent/workflow');
    expect(vi.mocked(requestChanges)).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: chat.id, feedback: 'hello' }),
    );
  });

  it('404s unknown chats and still accepts live ones', async () => {
    expect((await post('no-such-chat')).status).toBe(404);

    const chat = await prisma.chat.create({
      data: { branchId, workBranch: 'c-archgate2', createdById: ACTOR.id, title: 'Live' },
    });
    expect((await post(chat.id)).status).toBe(202);
  });
});
