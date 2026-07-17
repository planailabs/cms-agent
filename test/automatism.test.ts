/**
 * Automatism engine — runs steps in order posting role:'automatism' messages,
 * pauses on a failed step (persisting the failure context in the agent chat),
 * and resumes from exactly the failed step. Agent invocation itself is not
 * exercised here (invokeAgent 'continue' turns need a model backend); the
 * paused state + transcript are what the agent consumes.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The engine invokes the agent on failure — stub the handler so the test
// doesn't start a real model turn.
vi.mock('@/lib/agent/handler', () => ({ handleChatMessage: vi.fn(async () => {}) }));

import { prisma } from '@/lib/db';
import {
  AutomatismFailure,
  findPausedAutomatism,
  postAutomatismMessage,
  registerAutomatism,
  resumeAutomatism,
  startAutomatism,
} from '@/lib/automatism';

const waitFor = async (cond: () => Promise<boolean>, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not reached');
};

let chatId = '';
let agentChatId = '';

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: 'auto-user' } });
  await prisma.branch.deleteMany({ where: { name: 'auto-target' } });
  const u = await prisma.user.create({ data: { id: 'auto-user', name: 'A', email: 'auto@example.com' } });
  const b = await prisma.branch.create({ data: { name: 'auto-target', createdById: u.id } });
  const home = await prisma.chat.create({
    data: { branchId: b.id, workBranch: 'c-autotest1', kind: 'deployment', title: 'Auto', createdById: u.id },
  });
  const agent = await prisma.chat.create({
    data: { branchId: b.id, workBranch: 'c-autotest2', title: 'Agent side', createdById: u.id },
  });
  chatId = home.id;
  agentChatId = agent.id;
});

describe('automatism engine', () => {
  it('runs steps in order, posts events, completes', async () => {
    const ran: string[] = [];
    registerAutomatism({
      type: 'test-ok',
      steps: [
        { name: 'one', run: async (_d, post) => { ran.push('one'); await post('one done'); } },
        { name: 'two', run: async (_d, post) => { ran.push('two'); await post('two done'); } },
      ],
    });
    const id = await startAutomatism('test-ok', chatId, { actorId: 'auto-user' });
    await waitFor(async () => (await prisma.automatism.findUnique({ where: { id } }))?.status === 'done');
    expect(ran).toEqual(['one', 'two']);
    const msgs = await prisma.message.findMany({ where: { chatId }, orderBy: { ordinal: 'asc' } });
    expect(msgs.filter((m) => m.role === 'automatism').map((m) => m.content)).toContain('one done');
  });

  it('pauses on failure (context in the agent chat) and resumes from the failed step', async () => {
    let fail = true;
    const ran: string[] = [];
    registerAutomatism({
      type: 'test-fail',
      steps: [
        { name: 'prep', run: async () => { ran.push('prep'); } },
        {
          name: 'flaky',
          run: async () => {
            ran.push('flaky');
            if (fail) throw new AutomatismFailure('boom: fix me', agentChatId);
          },
        },
        { name: 'after', run: async () => { ran.push('after'); } },
      ],
    });
    const id = await startAutomatism('test-fail', chatId, { actorId: 'auto-user' });
    await waitFor(async () => (await prisma.automatism.findUnique({ where: { id } }))?.status === 'paused');

    const row = await prisma.automatism.findUnique({ where: { id } });
    expect(row?.step).toBe(1);
    expect(row?.lastError).toContain('boom');
    expect(row?.agentChatId).toBe(agentChatId);

    // Failure context landed in the agent chat, reachable for resume from there
    const agentMsgs = await prisma.message.findMany({ where: { chatId: agentChatId } });
    expect(agentMsgs.some((m) => m.role === 'automatism' && m.content.includes('resume_automatism'))).toBe(true);
    expect((await findPausedAutomatism(agentChatId))?.id).toBe(id);

    fail = false;
    expect(await resumeAutomatism(id)).toBe(true);
    await waitFor(async () => (await prisma.automatism.findUnique({ where: { id } }))?.status === 'done');
    // 'prep' ran once; 'flaky' re-ran; 'after' ran after the resume
    expect(ran).toEqual(['prep', 'flaky', 'flaky', 'after']);
  });

  it('turn adapter survives an automatism message landing mid-turn (ordinal resync)', async () => {
    const { createDbAdapter } = await import('@/lib/agent/persistence');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: 'auto-user' } });
    const b = await prisma.branch.findFirstOrThrow({ where: { name: 'auto-target' } });
    const chat = await prisma.chat.create({
      data: { branchId: b.id, workBranch: 'c-autotest3', title: 'Race', createdById: u.id },
    });
    const adapter = createDbAdapter(chat.id, u.id, [], { value: 0 });
    await adapter.appendMsg({ role: 'user', content: 'start' });
    // Automatism takes the next ordinal behind the adapter's back
    await postAutomatismMessage(chat.id, 'interleaved event');
    await adapter.appendMsg({ role: 'assistant', content: 'reply' }); // would collide without resync
    const rows = await prisma.message.findMany({ where: { chatId: chat.id }, orderBy: { ordinal: 'asc' } });
    expect(rows.map((r) => [r.ordinal, r.role])).toEqual([
      [0, 'user'],
      [1, 'automatism'],
      [2, 'assistant'],
    ]);
  });

  it('assigns sequential ordinals even with concurrent posts', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_v, i) => postAutomatismMessage(chatId, `parallel ${i}`)),
    );
    const msgs = await prisma.message.findMany({ where: { chatId }, orderBy: { ordinal: 'asc' } });
    const ordinals = msgs.map((m) => m.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });
});
