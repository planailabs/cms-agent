import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';

describe('throwaway sqlite db', () => {
  it('creates user → branch → chat with Json fields', async () => {
    // branch first: chats cascade from it, and user deletion is restricted
    // while branches/chats reference it
    await prisma.branch.deleteMany({ where: { name: 'smoke-draft' } });
    await prisma.user.deleteMany({ where: { id: 'smoke-u1' } });
    const u = await prisma.user.create({
      data: { id: 'smoke-u1', name: 'Test', email: 'smoke@example.com' },
    });
    const b = await prisma.branch.create({ data: { name: 'smoke-draft', createdById: u.id } });
    const c = await prisma.chat.create({
      data: { branchId: b.id, createdById: u.id, planJson: { steps: ['a', 'b'] } },
    });

    const back = await prisma.chat.findUniqueOrThrow({ where: { id: c.id } });
    expect(back.workflowPhase).toBe('plan');
    expect(back.turnPhase).toBe('idle');
    expect(back.planJson).toEqual({ steps: ['a', 'b'] });

    // cleanup so reruns on the same push are stable
    await prisma.branch.delete({ where: { id: b.id } });
    await prisma.user.delete({ where: { id: u.id } });
  });
});
