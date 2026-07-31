/**
 * A deployment chat may not be used to change the site.
 *
 * It runs with EXECUTE tools on the source chat's worktree so it can resolve a
 * conflict or fix a broken build — which also means "and while you're at it,
 * make the hero blue" would otherwise land as an uncommitted edit on a branch
 * whose review is over, in a chat that publishes nothing. The prompt tells the
 * agent to refuse; this is the gate that does not depend on it obeying.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';
import '@/lib/agent/handler'; // registers the tools

const ACTOR = { id: 'deploy-writes-user', name: 'Dep', email: 'deploy-writes@example.com' };
let worktree: string;
let deployChatId: string;
let workflowChatId: string;

const ctxFor = (chatId: string, chatKind: 'workflow' | 'deployment'): ToolContext =>
  ({
    chatId,
    chatKind,
    workflowPhase: 'execute',
    worktreePath: worktree,
    modifiedPaths: new Set(),
  }) as unknown as ToolContext;

const write = (chatId: string, kind: 'workflow' | 'deployment', file: string) =>
  executeTool('write_file', { path: file, content: 'edited\n' }, ctxFor(chatId, kind)).then(
    (raw) => JSON.parse(raw) as { success?: boolean; error?: string },
  );

const pause = () =>
  prisma.automatism.create({
    data: { chatId: deployChatId, type: 'deploy', status: 'paused', data: { actorId: ACTOR.id } },
  });

beforeAll(async () => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-deploy-writes-'));
  fs.mkdirSync(path.join(worktree, 'src', 'pages'), { recursive: true });

  await prisma.chat.deleteMany({ where: { workBranch: { startsWith: 'c-depwrite' } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  await prisma.user.deleteMany({ where: { email: ACTOR.email } });
  const user = await prisma.user.create({ data: ACTOR });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: user.id },
  });
  const chat = (kind: string, workBranch: string) =>
    prisma.chat.create({
      data: { branchId: branch.id, workBranch, kind, createdById: user.id, workflowPhase: 'execute' },
    });
  deployChatId = (await chat('deployment', 'c-depwrite-deploy')).id;
  workflowChatId = (await chat('workflow', 'c-depwrite-work')).id;
});

afterAll(async () => {
  await prisma.chat.deleteMany({ where: { workBranch: { startsWith: 'c-depwrite' } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  fs.rmSync(worktree, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.automatism.deleteMany({ where: { chatId: deployChatId } });
});

describe('writes from a deployment chat', () => {
  it('are refused while nothing is paused, and change nothing on disk', async () => {
    const out = await write(deployChatId, 'deployment', 'src/pages/index.astro');
    expect(out.error).toMatch(/deployment chat/i);
    expect(out.error).toMatch(/editorial chat/i);
    expect(fs.existsSync(path.join(worktree, 'src/pages/index.astro'))).toBe(false);
  });

  it('are allowed once the deploy is paused on a failure', async () => {
    await pause();
    const out = await write(deployChatId, 'deployment', 'src/pages/index.astro');
    expect(out.success).toBe(true);
    expect(fs.readFileSync(path.join(worktree, 'src/pages/index.astro'), 'utf8')).toBe('edited\n');
  });

  it('stay refused once the deploy has resumed', async () => {
    const row = await pause();
    await prisma.automatism.update({ where: { id: row.id }, data: { status: 'running' } });
    const out = await write(deployChatId, 'deployment', 'src/pages/about.astro');
    expect(out.error).toMatch(/deployment chat/i);
  });

  it('never touch .scratch/, which is neither committed nor published', async () => {
    const out = await write(deployChatId, 'deployment', '.scratch/notes.md');
    expect(out.success).toBe(true);
  });

  it('leave workflow chats alone', async () => {
    const out = await write(workflowChatId, 'workflow', 'src/pages/blog.astro');
    expect(out.success).toBe(true);
  });

  it('cover run_command, which writes through the sandbox', async () => {
    const raw = await executeTool(
      'run_command',
      { command: 'echo hi > src/pages/index.astro', timeoutSeconds: 5 },
      ctxFor(deployChatId, 'deployment'),
    );
    // Refused before the sandbox is ever built, so this needs no jail.
    expect(JSON.parse(raw).error).toMatch(/deployment chat/i);
  });
});
