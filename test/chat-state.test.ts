/**
 * Streamed chat state (phase 1): buildChatState snapshots, emitChatState
 * coalescing + seq, and snapshot/stream/history parity — the property the
 * whole design rests on.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { addConnection } from '@/lib/agent/bus';
import { buildChatState, emitChatState } from '@/lib/agent/chatState';
import { GET as historyGet } from '@/pages/api/chat/history';

let chatId: string;

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeAll(async () => {
  await prisma.chat.deleteMany({ where: { workBranch: 'c-statetest1' } });
  const branch = await prisma.branch.upsert({
    where: { name: 'state-test-target' },
    create: { name: 'state-test-target' },
    update: {},
  });
  const chat = await prisma.chat.create({
    data: {
      branchId: branch.id,
      workBranch: 'c-statetest1',
      title: 'State test chat',
      workflowPhase: 'execute',
      planJson: { summary: 'Test plan' },
    },
  });
  chatId = chat.id;
  await prisma.execution.create({
    data: { chatId, sha: 'a'.repeat(40), summary: 'first', revertedBySha: 'b'.repeat(40) },
  });
  await prisma.execution.create({ data: { chatId, sha: 'c'.repeat(40), summary: 'second' } });
});

describe('streamed chat state', () => {
  it('builds a snapshot with derived executionSha and gated publication', async () => {
    const state = await buildChatState(chatId);
    expect(state).not.toBeNull();
    expect(state!.workflowPhase).toBe('execute');
    expect(state!.title).toBe('State test chat');
    expect(state!.planJson).toEqual({ summary: 'Test plan' });
    expect(state!.executions).toHaveLength(2);
    // reverted execution is not publishable
    expect(state!.executionSha).toBe('c'.repeat(40));
    // publication only surfaces in the published phase
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
    await prisma.publication.create({
      data: {
        chatId,
        branchId: chat.branchId,
        sha: 'c'.repeat(40),
        flow: 'git-push',
        status: 'succeeded',
        log: 'ok',
      },
    });
    expect((await buildChatState(chatId))!.publication).toBeNull();
    await prisma.chat.update({ where: { id: chatId }, data: { workflowPhase: 'published' } });
    expect((await buildChatState(chatId))!.publication?.status).toBe('succeeded');
    await prisma.chat.update({ where: { id: chatId }, data: { workflowPhase: 'execute' } });
  });

  it('emits coalesced, sequenced state events matching the builder', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const remove = addConnection(chatId, {
      write: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      end: () => {},
    });
    try {
      // same-tick calls coalesce into ONE snapshot
      emitChatState(chatId);
      emitChatState(chatId, { clientId: 'me' });
      await flush();
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('state');
      const first = events[0].data.state as Record<string, unknown>;
      expect(first.seq).toBe(1);
      expect(events[0].data.clientId).toBe('me');

      emitChatState(chatId);
      await flush();
      expect(events).toHaveLength(2);
      const second = events[1].data.state as Record<string, unknown>;
      expect(second.seq).toBe(2);
      expect(second.epoch).toBe(first.epoch);

      // parity: the streamed snapshot equals a fresh build (modulo seq);
      // JSON-normalize both sides (the fake writer sees raw Date objects)
      const rebuilt = await buildChatState(chatId);
      expect(JSON.parse(JSON.stringify({ ...second, seq: 0 }))).toEqual(
        JSON.parse(JSON.stringify({ ...rebuilt, seq: 0 })),
      );
    } finally {
      remove();
    }
  });

  it('history returns the same snapshot the stream uses', async () => {
    const res = await historyGet({
      url: new URL(`http://localhost/api/chat/history?chatId=${chatId}`),
    } as never);
    const body = (await res.json()) as {
      state: Record<string, unknown>;
      workflowPhase: string;
      executions: unknown[];
      planJson: unknown;
    };
    const rebuilt = await buildChatState(chatId);
    expect({ ...body.state, seq: 0 }).toEqual(JSON.parse(JSON.stringify({ ...rebuilt, seq: 0 })));
    // flat compat fields mirror the snapshot
    expect(body.workflowPhase).toBe(body.state.workflowPhase);
    expect(body.planJson).toEqual(body.state.planJson);
    expect(body.executions).toEqual(body.state.executions);
  });
});
