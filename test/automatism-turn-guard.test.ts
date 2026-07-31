/**
 * An automatism may not start on top of a live turn.
 *
 * Sync rebases the work branch and publish merges it — both rewrite the very
 * worktree a running turn is editing. The steps take the branch lock for their
 * git calls, but that only serializes commands; it cannot make a half-finished
 * execution coherent. The agent's next write would land on commits that no
 * longer exist, which is exactly the "the work branch moved since you reviewed
 * it" dead end from the other direction.
 */
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { acquireTurnLock, releaseTurnLock } from '@/lib/agent/bus';
import { registerAutomatism, startAutomatism, TurnInProgressError } from '@/lib/automatism';
import { startPull, publish } from '@/lib/publish/publisher';
import { WorkflowError } from '@/lib/agent/workflow';

const ACTOR = { id: 'turn-guard-user', name: 'Guard', email: 'guard@example.com' };
let branchId: string;
let chatId: string;
const locks: Array<[string, string]> = [];

/** A do-nothing type, so the guard is what decides — not a step failing. */
registerAutomatism({ type: 'test-noop', steps: [{ name: 'noop', async run() {} }] });

const hold = (id: string): void => {
  const lockId = acquireTurnLock(id);
  expect(lockId, 'the turn lock was already held').toBeTruthy();
  locks.push([id, lockId!]);
};

beforeAll(async () => {
  await prisma.chat.deleteMany({ where: { workBranch: { startsWith: 'c-turnguard' } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  const user = await prisma.user.create({ data: ACTOR });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: user.id },
  });
  branchId = branch.id;
  const chat = await prisma.chat.create({
    data: { branchId, workBranch: 'c-turnguard-1', createdById: ACTOR.id, workflowPhase: 'execute' },
  });
  chatId = chat.id;
});

afterEach(() => {
  while (locks.length) {
    const [id, lockId] = locks.pop()!;
    releaseTurnLock(id, lockId);
  }
});

describe('automatisms and a live turn', () => {
  it('refuses to spawn one while the chat has a running turn', async () => {
    hold(chatId);
    await expect(startAutomatism('test-noop', chatId, { actorId: ACTOR.id })).rejects.toBeInstanceOf(
      TurnInProgressError,
    );
    expect(await prisma.automatism.count({ where: { chatId } })).toBe(0);
  });

  it('refuses when the turn runs in the workflow chat the steps would touch', async () => {
    // A deploy lives on its own deployment chat but merges the WORKFLOW
    // chat's branch — the lock that matters is the one on the work.
    const deployChat = await prisma.chat.create({
      data: { branchId, workBranch: 'c-turnguard-deploy', kind: 'deployment', createdById: ACTOR.id },
    });
    hold(chatId);
    await expect(
      startAutomatism('test-noop', deployChat.id, { actorId: ACTOR.id, workflowChatId: chatId }),
    ).rejects.toBeInstanceOf(TurnInProgressError);
  });

  it('lets one start once the turn has finished', async () => {
    const id = await startAutomatism('test-noop', chatId, { actorId: ACTOR.id });
    expect(id).toBeTruthy();
    await prisma.automatism.deleteMany({ where: { chatId } });
  });

  it('answers the sync endpoint with a 409, not a crash', async () => {
    hold(chatId);
    const err = await startPull(chatId, ACTOR, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).status).toBe(409);
    expect((err as WorkflowError).message).toMatch(/agent is working/i);
  });

  // finalize resumes the paused agent to close its finish_execution card, so
  // the Publish that follows a second later races a turn that is already
  // ending. Refusing it made the whole finalize → publish sequence fail.
  it('waits for a turn that is about to end instead of refusing', async () => {
    hold(chatId);
    setTimeout(() => {
      const [id, lockId] = locks.pop()!;
      releaseTurnLock(id, lockId);
    }, 300);
    const err = await publish({
      chatId,
      sha: 'a'.repeat(40),
      actor: { ...ACTOR, role: 'admin' },
    }).catch((e: unknown) => e);
    // It got past the turn guard — whatever stops it later (here: the test
    // env has no git repo behind REPO_PATH) is not "the agent is working".
    expect(String((err as Error).message)).not.toMatch(/agent is working/i);
  });

  it('refuses a publish for the same reason', async () => {
    hold(chatId);
    const err = await publish({
      chatId,
      sha: 'a'.repeat(40),
      actor: { ...ACTOR, role: 'admin' },
      settleMs: 50,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).status).toBe(409);
    // Refused before the sha binding is even considered — a turn in flight
    // means the branch head is not a thing anyone reviewed.
    expect((err as WorkflowError).message).toMatch(/agent is working/i);
  });
});
