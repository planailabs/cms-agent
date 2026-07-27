/**
 * Streamed chat state (phase 1): buildChatState snapshots, emitChatState
 * coalescing + seq, and snapshot/stream/history parity — the property the
 * whole design rests on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { prisma } from '@/lib/db';
import { addConnection } from '@/lib/agent/bus';
import { buildChatState, emitChatState } from '@/lib/agent/chatState';
import { acquireTurnLock, releaseTurnLock } from '@/lib/agent/bus';
import { GET as historyGet } from '@/pages/api/chat/history';
import { loadChatRecord } from '@/lib/agent/persistence';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';

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
    // remote turn state: pending question only while waiting_for_answer
    expect(state!.turnPhase).toBe('idle');
    expect(state!.canResume).toBe(false);
    expect(state!.pendingQuestion).toBeNull();
    await prisma.chat.update({
      where: { id: chatId },
      data: {
        turnPhase: 'waiting_for_answer',
        pendingQuestion: { toolName: 'ask_question', input: { question: 'Q?' } },
      },
    });
    expect((await buildChatState(chatId))!.pendingQuestion?.toolName).toBe('ask_question');
    await prisma.chat.update({
      where: { id: chatId },
      data: { turnPhase: 'idle' },
    });
    expect((await buildChatState(chatId))!.pendingQuestion).toBeNull();
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

  it('offers resume only when interrupted work has no active turn owner', async () => {
    await prisma.chat.update({
      where: { id: chatId },
      data: { turnPhase: 'running' },
    });
    expect((await buildChatState(chatId))!.canResume).toBe(true);

    await prisma.chat.update({
      where: { id: chatId },
      data: { turnPhase: 'tool_pending' },
    });
    expect((await buildChatState(chatId))!.canResume).toBe(true);

    const lock = acquireTurnLock(chatId);
    expect(lock).not.toBeNull();
    try {
      expect((await buildChatState(chatId))!.canResume).toBe(false);
    } finally {
      releaseTurnLock(chatId, lock!);
      await prisma.chat.update({
        where: { id: chatId },
        data: { turnPhase: 'idle' },
      });
    }
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

  it('every workflow transition emits a snapshot equal to a fresh build', async () => {
    // Real repo so approvePlan's git prep (ensureBranch/branchSha) works.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-statetrans-'));
    const repo = path.join(tmp, 'site');
    fs.mkdirSync(repo);
    const git = simpleGit(repo);
    await git.init(['-b', 'state-test-target']);
    await git.addConfig('user.name', 'T');
    await git.addConfig('user.email', 't@t');
    fs.writeFileSync(path.join(repo, 'index.md'), '# Home\n');
    await git.add(['-A']);
    await git.commit('init');
    process.env.REPO_PATH = repo;
    const { resetEnvCache } = await import('@/lib/env');
    resetEnvCache();

    await prisma.user.upsert({
      where: { id: 'state-trans-user' },
      create: { id: 'state-trans-user', name: 'Transitioner', email: 'trans@example.com' },
      update: {},
    });
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { name: 'state-test-target' },
    });
    await prisma.chat.deleteMany({ where: { workBranch: 'c-statetrans1' } });
    const chat = await prisma.chat.create({
      data: {
        branchId: branch.id,
        workBranch: 'c-statetrans1',
        title: 'Transition test',
        workflowPhase: 'plan',
        turnPhase: 'idle',
        planJson: { summary: 'Approve me' },
      },
    });

    const events: Array<Record<string, unknown>> = [];
    const remove = addConnection(chat.id, {
      write: (event, data) => {
        if (event === 'state') events.push(data as Record<string, unknown>);
      },
      end: () => {},
    });
    const actor = { id: 'state-trans-user', name: 'Transitioner', email: 'trans@example.com' };
    const lastSnapshot = () =>
      events[events.length - 1].state as Record<string, unknown>;
    const expectParity = async () => {
      const rebuilt = await buildChatState(chat.id);
      expect(JSON.parse(JSON.stringify({ ...lastSnapshot(), seq: 0 }))).toEqual(
        JSON.parse(JSON.stringify({ ...rebuilt, seq: 0 })),
      );
    };

    try {
      const { approvePlan, requestChanges } = await import('@/lib/agent/workflow');

      await approvePlan({ chatId: chat.id, actor });
      await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(0);
      expect(lastSnapshot().workflowPhase).toBe('execute');
      await expectParity();

      const beforeReturn = events.length;
      const toolContext: ToolContext = {
        chatId: chat.id,
        branchId: branch.id,
        branchName: branch.name,
        userId: actor.id,
        workflowPhase: 'execute',
        chatKind: 'workflow',
        worktreePath: repo,
        userContext: new Map(),
        modifiedPaths: new Set(),
      };
      expect(
        JSON.parse(
          await executeTool(
            'return_to_plan',
            { reason: 'The approved structure needs revision' },
            toolContext,
          ),
        ),
      ).toMatchObject({ ok: true, phase: 'plan' });
      expect(toolContext.workflowPhase).toBe('plan');
      await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(beforeReturn);
      expect(lastSnapshot().workflowPhase).toBe('plan');
      await expectParity();

      // requestChanges is only legal from plan/preview — move to preview
      // the direct way (toPreview needs a dirty worktree; out of scope here).
      await prisma.chat.update({ where: { id: chat.id }, data: { workflowPhase: 'preview' } });
      const before = events.length;
      await requestChanges({ chatId: chat.id, actor, feedback: 'tweak it' });
      await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(before);
      expect(lastSnapshot().workflowPhase).toBe('plan');
      await expectParity();
    } finally {
      remove();
    }
  });

  it('emitChatStatesForBranch reaches every live chat, skipping archived', async () => {
    const { emitChatStatesForBranch } = await import('@/lib/agent/chatState');
    const branch = await prisma.branch.findUniqueOrThrow({ where: { name: 'state-test-target' } });
    await prisma.chat.deleteMany({ where: { workBranch: { in: ['c-statebr1', 'c-statebr2'] } } });
    const live = await prisma.chat.create({
      data: { branchId: branch.id, workBranch: 'c-statebr1', title: 'live' },
    });
    const archived = await prisma.chat.create({
      data: { branchId: branch.id, workBranch: 'c-statebr2', title: 'gone', archivedAt: new Date() },
    });

    const got: string[] = [];
    const removers = [live.id, archived.id].map((id) =>
      addConnection(id, {
        write: (event) => {
          if (event === 'state') got.push(id);
        },
        end: () => {},
      }),
    );
    try {
      emitChatStatesForBranch(branch.id);
      await expect.poll(() => got.length, { timeout: 5000 }).toBeGreaterThan(0);
      await flush();
      expect(got).toContain(live.id);
      expect(got).not.toContain(archived.id);
    } finally {
      removers.forEach((r) => r());
    }
  });

  it('history returns the same snapshot the stream uses', async () => {
    const res = await historyGet({
      url: new URL(`http://localhost/api/chat/history?chatId=${chatId}`),
      locals: { user: { id: 'u-test-admin', role: 'admin' } },
    } as never);
    const body = (await res.json()) as { state: Record<string, unknown> };
    const rebuilt = await buildChatState(chatId);
    expect({ ...body.state, seq: 0 }).toEqual(JSON.parse(JSON.stringify({ ...rebuilt, seq: 0 })));
    expect(body.state.turnPhase).toBeDefined(); // turn state lives IN the snapshot
  });

  it('loads conversation state from the newest compaction without deleting older rows', async () => {
    const branch = await prisma.branch.findUniqueOrThrow({ where: { name: 'state-test-target' } });
    const chat = await prisma.chat.create({
      data: { branchId: branch.id, workBranch: `c-compact-${Date.now()}` },
    });
    await prisma.message.createMany({
      data: [
        { chatId: chat.id, role: 'user', content: 'old request', ordinal: 0 },
        { chatId: chat.id, role: 'assistant', content: 'old response', ordinal: 1 },
        { chatId: chat.id, role: 'compaction', content: 'durable summary', ordinal: 2 },
        { chatId: chat.id, role: 'user', content: 'new request', ordinal: 3 },
      ],
    });

    const record = await loadChatRecord(chat.id);
    expect(record?.messages.map((m) => m.role)).toEqual(['compaction', 'user']);
    expect(record?.nextOrdinal).toBe(4);

    const res = await historyGet({
      url: new URL(`http://localhost/api/chat/history?chatId=${chat.id}`),
      locals: { user: { id: 'u-test-admin', role: 'admin' } },
    } as never);
    const body = (await res.json()) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(['compaction', 'user']);
    expect(body.messages[0].content).toBe('durable summary');
    expect(await prisma.message.count({ where: { chatId: chat.id } })).toBe(4);
  });
});
