/**
 * The repair turn — the part of an automatism failure that actually fixes it.
 *
 * Pausing a flow is only useful if somebody then works on it, and that
 * somebody is an agent turn the engine starts itself. Every interesting case
 * is the chat being busy when that moment arrives: a deploy hands its merge
 * conflict to the workflow chat, which may already be running a turn (its own,
 * or one started by an earlier failure). A repair that quietly gives up there
 * leaves the flow paused with nobody on it and nothing on screen saying so.
 *
 * The failures below therefore direct their repair at a second chat and take
 * that chat's turn lock first — which is exactly what the takeover path does
 * in production.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { handleChatMessage } = vi.hoisted(() => ({ handleChatMessage: vi.fn(async () => {}) }));
vi.mock('@/lib/agent/handler', () => ({ handleChatMessage }));

import { prisma } from '@/lib/db';
import { acquireTurnLock, releaseTurnLock } from '@/lib/agent/bus';
import {
  AutomatismFailure,
  registerAutomatism,
  setAgentInvokeWaitMs,
  startAutomatism,
} from '@/lib/automatism';

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not reached');
};

let agentChatId = '';
const homeChats: string[] = [];
let restoreWait = 0;
/** Set per test: the step takes the agent chat's turn lock before it fails. */
let holdLock = false;
let heldLock: string | null = null;

registerAutomatism({
  type: 'repair-test',
  steps: [
    {
      name: 'flaky',
      run: async () => {
        // A turn already running in the chat the repair is aimed at.
        if (holdLock && !heldLock) heldLock = acquireTurnLock(agentChatId);
        throw new AutomatismFailure('the step broke', agentChatId);
      },
    },
  ],
});

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: 'repair-user' } });
  await prisma.branch.deleteMany({ where: { name: 'repair-target' } });
  const user = await prisma.user.create({
    data: { id: 'repair-user', name: 'R', email: 'repair@example.com' },
  });
  const branch = await prisma.branch.create({
    data: { name: 'repair-target', createdById: user.id },
  });
  const agent = await prisma.chat.create({
    data: { branchId: branch.id, workBranch: 'c-repair-agent', title: 'Agent', createdById: user.id },
  });
  agentChatId = agent.id;
  for (const n of [1, 2]) {
    const home = await prisma.chat.create({
      data: {
        branchId: branch.id,
        workBranch: `c-repair-home-${n}`,
        kind: 'deployment',
        title: `Home ${n}`,
        createdById: user.id,
      },
    });
    homeChats.push(home.id);
  }
});

beforeEach(async () => {
  handleChatMessage.mockClear();
  holdLock = false;
  heldLock = null;
  restoreWait = setAgentInvokeWaitMs(2500);
  await prisma.automatism.deleteMany({ where: { chatId: { in: homeChats } } });
  await prisma.message.deleteMany({ where: { chatId: { in: [...homeChats, agentChatId] } } });
  await prisma.chat.update({ where: { id: agentChatId }, data: { lastError: null } });
});

afterEach(() => {
  setAgentInvokeWaitMs(restoreWait);
  if (heldLock) releaseTurnLock(agentChatId, heldLock);
  heldLock = null;
});

const start = (home = 0) =>
  startAutomatism('repair-test', homeChats[home], { actorId: 'repair-user' });

describe('the repair turn a failure starts', () => {
  it('runs in the chat the failure was handed to, as soon as it is idle', async () => {
    await start();
    await waitFor(() => handleChatMessage.mock.calls.length > 0);
    const [, , body] = handleChatMessage.mock.calls[0] as unknown as [
      string,
      string,
      { chatId: string; type: string },
    ];
    expect(body.chatId).toBe(agentChatId);
    // A 'continue' turn: the failure is already in the transcript, so nothing
    // is added to it — the agent just gets to act on what it reads.
    expect(body.type).toBe('continue');
  });

  it('waits out the turn already running instead of dropping the repair', async () => {
    holdLock = true;
    await start();
    await new Promise((r) => setTimeout(r, 400));
    expect(handleChatMessage).not.toHaveBeenCalled();

    releaseTurnLock(agentChatId, heldLock!);
    heldLock = null;
    await waitFor(() => handleChatMessage.mock.calls.length > 0);
  });

  it('folds a second failure into the turn already waiting, never two turns', async () => {
    holdLock = true;
    await start(0);
    await waitFor(() => heldLock !== null);
    await start(1);
    await new Promise((r) => setTimeout(r, 400));

    releaseTurnLock(agentChatId, heldLock!);
    heldLock = null;
    await waitFor(() => handleChatMessage.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 500));
    // Two turns would race for the same worktree; one reads both failures.
    expect(handleChatMessage).toHaveBeenCalledTimes(1);
  });

  it('says so in the chat when it could not start a turn at all', async () => {
    holdLock = true;
    await start();
    await waitFor(async () => {
      const chat = await prisma.chat.findUniqueOrThrow({ where: { id: agentChatId } });
      return chat.lastError !== null;
    });
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: agentChatId } });
    expect(chat.lastError).toContain('Retry');

    const texts = (await prisma.message.findMany({ where: { chatId: agentChatId } })).map(
      (m) => m.content,
    );
    expect(texts.some((t) => t.includes('busy'))).toBe(true);
    expect(handleChatMessage).not.toHaveBeenCalled();
  });
});
