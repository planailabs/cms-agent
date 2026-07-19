/**
 * Flow-defined deploy phases + flow-scoped tools: flows with `steps` get
 * their own automatism type with those step names, and flow `tools` are only
 * exposed in deployment chats running that flow.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { automatismStateFor } from '@/lib/automatism';
import { toolsForPhase } from '@/lib/agent/tools/registry';
import '@/lib/publish/publisher'; // registers flows, flow tools, automatism types

describe('flow-defined deploy steps', () => {
  it('registers a per-flow automatism type with the flow phase names', async () => {
    const stale = await prisma.chat.findMany({
      where: { workBranch: 'c-flowtest1' },
      select: { id: true },
    });
    await prisma.automatism.deleteMany({ where: { chatId: { in: stale.map((c) => c.id) } } });
    await prisma.chat.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });
    await prisma.branch.deleteMany({ where: { name: 'flow-target' } });
    await prisma.user.deleteMany({ where: { id: 'flow-user' } });
    const u = await prisma.user.create({
      data: { id: 'flow-user', name: 'F', email: 'flow@example.com' },
    });
    const b = await prisma.branch.create({ data: { name: 'flow-target', createdById: u.id } });
    const chat = await prisma.chat.create({
      data: { branchId: b.id, workBranch: 'c-flowtest1', kind: 'deployment', createdById: u.id },
    });
    await prisma.automatism.create({
      data: { chatId: chat.id, type: 'deploy:web-agency', data: { actorId: u.id } },
    });
    const state = await automatismStateFor(chat.id);
    expect(state?.steps).toEqual(['merge', 'build', 'deploy', 'verify', 'finalize']);
  });

  it('exposes flow tools only to deployment chats of that flow', () => {
    const names = (flowId?: string) =>
      toolsForPhase('execute', 'deployment', flowId).map((t) => t.name);
    expect(names('web-agency')).toContain('artifact_info');
    expect(names('git-push')).not.toContain('artifact_info');
    expect(names(undefined)).not.toContain('artifact_info');
    // and never in workflow chats
    expect(toolsForPhase('execute', 'workflow', 'web-agency').map((t) => t.name)).not.toContain(
      'artifact_info',
    );
  });
});
