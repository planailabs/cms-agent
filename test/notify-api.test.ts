/**
 * /api/chats/:id/notify — the contract the modal is written against: one
 * shape for both verbs, the phone saved in the same request that arms SMS,
 * and a number the vendor would reject refused here rather than at 3am.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { registerNotifyProvider } from '@/lib/notify';
import { GET, PUT } from '@/pages/api/chats/[id]/notify';

const OWNER = 'notifyapi-owner';
const STRANGER = 'notifyapi-stranger';

let chatId: string;

interface NotifyBody {
  channels?: string[];
  available?: string[];
  missingAddress?: string[];
  phone?: string | null;
  email?: string | null;
  error?: string;
}

const asUser = (id: string, role = 'editor') => ({ user: { id, role } });

const get = (userId: string) =>
  GET({ params: { id: chatId }, locals: asUser(userId) } as never);

const put = (userId: string, body: unknown) =>
  PUT({
    params: { id: chatId },
    request: new Request('http://x/api/chats/x/notify', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    locals: asUser(userId),
  } as never);

const bodyOf = async (res: Response): Promise<NotifyBody> => (await res.json()) as NotifyBody;

beforeAll(async () => {
  registerNotifyProvider({ id: 'apitest', channel: 'sms', async send() {} });
  registerNotifyProvider({ id: 'apitest', channel: 'email', async send() {} });
  process.env.NOTIFY_SMS_PROVIDER = 'apitest';
  process.env.NOTIFY_EMAIL_PROVIDER = 'apitest';
  resetEnvCache();

  for (const [id, email] of [
    [OWNER, 'notifyapi-owner@example.com'],
    [STRANGER, 'notifyapi-stranger@example.com'],
  ] as const) {
    await prisma.user.upsert({
      where: { id },
      create: { id, name: id, email },
      update: { phone: null },
    });
  }
  // The throwaway SQLite DB is reused across runs — start from a known
  // state rather than colliding with the last run's chat.
  await prisma.chat.deleteMany({ where: { workBranch: 'c-notifyapi1' } });
  const branch = await prisma.branch.upsert({
    where: { name: 'notifyapi-target' },
    create: { name: 'notifyapi-target' },
    update: {},
  });
  const chat = await prisma.chat.create({
    data: {
      branchId: branch.id,
      workBranch: 'c-notifyapi1',
      title: 'API chat',
      createdById: OWNER,
    },
  });
  chatId = chat.id;
});

beforeEach(async () => {
  await prisma.chatNotification.deleteMany({ where: { chatId } });
  await prisma.user.update({ where: { id: OWNER }, data: { phone: null } });
  await prisma.appSetting.deleteMany({ where: { key: 'chats.sharedVisibility' } });
});

describe('GET /api/chats/:id/notify', () => {
  it('reports what is configured, what is armed, and what has no address', async () => {
    const body = await bodyOf(await get(OWNER));
    expect(body.channels).toEqual([]);
    expect(body.available?.sort()).toEqual(['email', 'sms']);
    // Email arrives with the SSO identity; the number does not.
    expect(body.missingAddress).toEqual(['sms']);
    expect(body.email).toBe('notifyapi-owner@example.com');
    expect(body.phone).toBeNull();
  });

  it('404s a chat that does not exist', async () => {
    const res = await GET({ params: { id: 'no-such-chat' }, locals: asUser(OWNER) } as never);
    expect(res.status).toBe(404);
  });

  it('404s for a viewer who may not see the chat', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'chats.sharedVisibility' },
      create: { key: 'chats.sharedVisibility', value: false },
      update: { value: false },
    });
    expect((await get(STRANGER)).status).toBe(404);
    expect((await put(STRANGER, { channels: ['email'] })).status).toBe(404);
    // …and nothing was armed on the way to being refused.
    expect(await prisma.chatNotification.count({ where: { chatId } })).toBe(0);
  });
});

describe('PUT /api/chats/:id/notify', () => {
  it('arms the channels and saves the number in one request', async () => {
    const body = await bodyOf(await put(OWNER, { channels: ['sms'], phone: '+49 170 1234567' }));
    expect(body.channels).toEqual(['sms']);
    expect(body.phone).toBe('+491701234567');
    expect(body.missingAddress).toEqual([]);
    expect(await prisma.chatNotification.count({ where: { chatId, userId: OWNER } })).toBe(1);
  });

  it('disarms on an empty list without forgetting the number', async () => {
    await put(OWNER, { channels: ['sms'], phone: '+491701234567' });
    const body = await bodyOf(await put(OWNER, { channels: [] }));
    expect(body.channels).toEqual([]);
    expect(body.phone).toBe('+491701234567');
    expect(await prisma.chatNotification.count({ where: { chatId } })).toBe(0);
  });

  it('clears the number on an explicit empty string', async () => {
    await put(OWNER, { channels: [], phone: '+491701234567' });
    expect((await bodyOf(await put(OWNER, { channels: [], phone: '' }))).phone).toBeNull();
  });

  it('refuses a number no provider would accept, and arms nothing', async () => {
    const res = await put(OWNER, { channels: ['sms'], phone: '0170 1234567' });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toContain('international format');
    expect(await prisma.chatNotification.count({ where: { chatId } })).toBe(0);
  });

  it('refuses to arm a channel this person has no address on', async () => {
    // Silence is what somebody who armed a bell will never investigate.
    const res = await put(OWNER, { channels: ['sms'] });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toContain('sms');
    expect(await prisma.chatNotification.count({ where: { chatId } })).toBe(0);
    // …and accepts it the moment the number arrives with the request.
    expect((await put(OWNER, { channels: ['sms'], phone: '+491701234567' })).status).toBe(200);
  });

  it('refuses a channel it does not know', async () => {
    expect((await put(OWNER, { channels: ['carrier-pigeon'] })).status).toBe(400);
    expect((await put(OWNER, { channels: 'email' })).status).toBe(400);
  });

  it('keeps arms per user — one person\'s bell is not another\'s', async () => {
    await put(OWNER, { channels: ['email'] });
    expect((await bodyOf(await get(STRANGER))).channels).toEqual([]);
    expect((await bodyOf(await get(OWNER))).channels).toEqual(['email']);
  });
});
