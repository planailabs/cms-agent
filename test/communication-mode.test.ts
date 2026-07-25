import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resolveCommunicationMode } from '@/lib/communicationMode';
import { GET, PATCH } from '@/pages/api/me';

const user = {
  id: 'communication-mode-user',
  name: 'Mode User',
  email: 'mode@example.com',
  role: 'editor',
  theme: 'system',
  language: 'en',
};

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: user.id },
    create: user,
    update: { communicationMode: 'default' },
  });
});

describe('communication mode preference', () => {
  it('resolves default and persists an explicit user choice', async () => {
    expect(resolveCommunicationMode('default', 'non-technical')).toBe('non-technical');
    expect(resolveCommunicationMode('default', 'technical')).toBe('technical');

    const patch = await PATCH({
      request: new Request('http://localhost/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ communicationMode: 'technical' }),
      }),
      locals: { user },
    } as never);
    expect(patch.status).toBe(200);

    const get = await GET({ locals: { user } } as never);
    expect(await get.json()).toMatchObject({
      communicationMode: 'technical',
      effectiveCommunicationMode: 'technical',
      defaultCommunicationMode: 'non-technical',
    });
  });
});
