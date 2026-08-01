/**
 * A publish is one fact: this chat is being published, by this person, at
 * this sha. Six rows say it — approval, the phase flip, the deployment chat,
 * the publication, its first message, the automatism — and they used to be
 * written one after another with the optimistic version gate in the middle.
 *
 * A gate that lost left an approval for a publish that never happened, and
 * the chat still in EXECUTE with an audit record claiming otherwise. This
 * pins the property the transaction exists for: when initialization fails,
 * nothing is left behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';

vi.mock('@/lib/agent/handler', () => ({ handleChatMessage: vi.fn(async () => {}) }));

import { prisma } from '@/lib/db';
import { acquireTurnLock, releaseTurnLock } from '@/lib/agent/bus';

const ACTOR = { id: 'ptx-user', name: 'Pub Tester', email: 'ptx@example.com', role: 'admin' };
let publisher: typeof import('@/lib/publish/publisher');
let branchId = '';
let head = '';

/** A chat in EXECUTE whose work branch is at `head`. */
const makeChat = async (workBranch: string) => {
  const engine = await import('@/lib/git/engine');
  await engine.ensureBranch(workBranch, 'main');
  return prisma.chat.create({
    data: {
      branchId,
      workBranch,
      createdById: ACTOR.id,
      workflowPhase: 'execute',
      title: 'Publish me',
    },
  });
};

const rowCounts = async (chatId: string) => ({
  approvals: await prisma.approval.count({ where: { chatId } }),
  publications: await prisma.publication.count({ where: { chatId } }),
  automatisms: await prisma.automatism.count({ where: { chatId } }),
});

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-ptx-test-'));
  const repo = path.join(base, 'site');
  fs.mkdirSync(repo, { recursive: true });
  const git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', 'Init');
  await git.addConfig('user.email', 'init@example.com');
  fs.writeFileSync(path.join(repo, 'index.md'), 'home\n');
  await git.add(['-A']);
  await git.commit('initial');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(base, 'var');
  resetEnvCache();

  // Upsert, not delete: a previous run's chats and approvals still reference
  // this user.
  await prisma.user.upsert({
    where: { id: ACTOR.id },
    update: {},
    create: { id: ACTOR.id, name: ACTOR.name, email: ACTOR.email },
  });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: ACTOR.id },
  });
  branchId = branch.id;

  publisher = await import('@/lib/publish/publisher');
  const engine = await import('@/lib/git/engine');
  head = await engine.branchSha('main');
}, 60_000);

describe('publish initialization', () => {
  it('leaves nothing behind when the version gate loses', async () => {
    const chat = await makeChat(`c-ptx-${Date.now()}`);
    // Other suites share this database, so count the delta, not the total.
    const deployChatsBefore = await prisma.chat.count({ where: { branchId, kind: 'deployment' } });
    // Someone else changed the chat between the page load and the click.
    await expect(
      publisher.publish({
        chatId: chat.id,
        sha: head,
        actor: ACTOR,
        expectedVersion: chat.entityVersion + 5,
        settleMs: 0,
      }),
    ).rejects.toThrow(/changed while you were deciding/i);

    // The approval was written BEFORE the gate. If the transaction did not
    // hold, it would survive as an audit record of a publish that never was.
    expect(await rowCounts(chat.id)).toEqual({
      approvals: 0,
      publications: 0,
      automatisms: 0,
    });
    // …and no half-created deployment chat.
    expect(await prisma.chat.count({ where: { branchId, kind: 'deployment' } })).toBe(
      deployChatsBefore,
    );
    const after = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(after.workflowPhase).toBe('execute');
  }, 60_000);

  it('commits all six rows together, and the first message is ordinal 0', async () => {
    const chat = await makeChat(`c-ptx-ok-${Date.now()}`);
    const result = await publisher.publish({
      chatId: chat.id,
      sha: head,
      actor: ACTOR,
      settleMs: 0,
    });

    expect(await rowCounts(chat.id)).toEqual({
      approvals: 1,
      publications: 1,
      automatisms: 0, // the automatism belongs to the deployment chat
    });
    expect(await prisma.automatism.count({ where: { chatId: result.deployChatId } })).toBe(1);
    const first = await prisma.message.findFirstOrThrow({
      where: { chatId: result.deployChatId },
      orderBy: { ordinal: 'asc' },
    });
    // A brand-new chat has no ordinals to race for, so the first message goes
    // in at 0 with no read-back and no retry (which a transaction forbids).
    expect(first.ordinal).toBe(0);
    expect(first.role).toBe('automatism');
    const published = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(published.workflowPhase).toBe('published');
  }, 60_000);

  it('refuses while a turn holds the chat, without writing anything', async () => {
    const chat = await makeChat(`c-ptx-busy-${Date.now()}`);
    const lockId = acquireTurnLock(chat.id)!;
    try {
      await expect(
        publisher.publish({ chatId: chat.id, sha: head, actor: ACTOR, settleMs: 10 }),
      ).rejects.toThrow(/agent is working/i);
      expect(await rowCounts(chat.id)).toEqual({
        approvals: 0,
        publications: 0,
        automatisms: 0,
      });
    } finally {
      releaseTurnLock(chat.id, lockId);
    }
  }, 60_000);
});
