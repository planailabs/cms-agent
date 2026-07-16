import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { registerClientTools } from '@/lib/agent/tools/clientTools';
import { registerDeployTools } from '@/lib/agent/tools/deployTools';
import { registerFsTools } from '@/lib/agent/tools/fsTools';
import { executeTool, toolsForPhase, type ToolContext } from '@/lib/agent/tools/registry';

registerClientTools();
registerDeployTools();
registerFsTools();

const ctx = (kind: ToolContext['chatKind']): ToolContext => ({
  chatId: 'dep-chat',
  branchId: 'dep-branch',
  branchName: 'main',
  userId: 'dep-user',
  workflowPhase: 'plan',
  chatKind: kind,
  worktreePath: '',
  userContext: new Map(),
  modifiedPaths: new Set(),
});

beforeAll(async () => {
  // publications reference the branch without cascade — clear them first
  await prisma.publication.deleteMany({ where: { branch: { name: 'dep-target' } } });
  await prisma.branch.deleteMany({ where: { name: 'dep-target' } });
  await prisma.user.deleteMany({ where: { id: 'dep-user' } });
  const u = await prisma.user.create({ data: { id: 'dep-user', name: 'D', email: 'dep@example.com' } });
  const b = await prisma.branch.create({ data: { name: 'dep-target', createdById: u.id } });
  const c = await prisma.chat.create({
    data: { branchId: b.id, workBranch: 'c-deptest1', createdById: u.id, title: 'Dep chat' },
  });
  await prisma.publication.create({
    data: {
      chatId: c.id,
      branchId: b.id,
      sha: 'a'.repeat(40),
      flow: 'web-agency',
      status: 'succeeded',
      log: 'Building…\nArtifact sealed\nDone.',
      externalUrl: 'https://example.com',
    },
  });
});

describe('deployments system chat', () => {
  it('gates the tool set by chat kind', () => {
    const deployTools = toolsForPhase('plan', 'deployments').map((t) => t.name);
    expect(deployTools).toContain('list_publications');
    expect(deployTools).toContain('ask_question');
    expect(deployTools).not.toContain('read_file');
    expect(deployTools).not.toContain('propose_plan');

    // and repo tools reject execution under the deployments kind
    return executeTool('read_file', { path: 'x' }, ctx('deployments')).then((res) => {
      expect(JSON.parse(res).error).toMatch(/not available in this chat/);
    });
  });

  it('lists and details persisted publications', async () => {
    const list = JSON.parse(await executeTool('list_publications', {}, ctx('deployments')));
    const entry = list.find((p: { sha: string }) => p.sha === 'a'.repeat(40));
    expect(entry).toMatchObject({
      status: 'succeeded',
      flow: 'web-agency',
      targetBranch: 'dep-target',
      externalUrl: 'https://example.com',
    });

    const detail = JSON.parse(
      await executeTool('get_publication', { idOrSha: 'a'.repeat(40) }, ctx('deployments')),
    );
    expect(detail.log).toContain('Artifact sealed');
    expect(detail.chat).toBe('Dep chat');
  });
});
