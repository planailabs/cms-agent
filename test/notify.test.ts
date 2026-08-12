/**
 * Turn-end notifications: the provider registry, how a channel is resolved
 * from the environment, and what actually happens when a turn ends.
 *
 * The properties worth pinning are the ones that cost money or silence when
 * they break — a channel firing without being configured, a fired arm that
 * stays armed, a provider failure that takes the turn down with it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import {
  addressFor,
  channelSetup,
  configuredChannels,
  deliver,
  normalizePhone,
  registerNotifyProvider,
  type NotifyMessage,
  type NotifyProviderConfig,
} from '@/lib/notify';
import { armedChannels, notifyTurnFinished, setArmedChannels } from '@/lib/notify/chatNotify';

const USER = 'notify-user-1';
const NO_PHONE_USER = 'notify-user-2';

/** What a provider was handed, in order. */
const sent: Array<{ channel: string; to: string; message: NotifyMessage; config: NotifyProviderConfig }> = [];

let smsShouldThrow = false;

const NOTIFY_ENV = [
  'NOTIFY_SMS_PROVIDER',
  'NOTIFY_SMS_FROM',
  'NOTIFY_SMS_CONFIG',
  'NOTIFY_EMAIL_PROVIDER',
  'NOTIFY_EMAIL_FROM',
  'NOTIFY_EMAIL_CONFIG',
] as const;

const setEnv = (values: Partial<Record<(typeof NOTIFY_ENV)[number], string>>): void => {
  for (const key of NOTIFY_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  resetEnvCache();
};

let chatId: string;

beforeAll(async () => {
  registerNotifyProvider({
    id: 'spy',
    channel: 'sms',
    async send(to, message, config) {
      if (smsShouldThrow) throw new Error('carrier rejected it');
      sent.push({ channel: 'sms', to, message, config });
    },
  });
  registerNotifyProvider({
    id: 'spy',
    channel: 'email',
    async send(to, message, config) {
      sent.push({ channel: 'email', to, message, config });
    },
  });

  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      name: 'Notify User',
      email: 'notify@example.com',
      phone: '+15551230000',
      language: 'en',
    },
    update: { phone: '+15551230000', language: 'en' },
  });
  await prisma.user.upsert({
    where: { id: NO_PHONE_USER },
    create: { id: NO_PHONE_USER, name: 'No Phone', email: 'nophone@example.com' },
    update: { phone: null },
  });

  // The throwaway SQLite DB is reused across runs — start from a known
  // state rather than colliding with the last run's chat.
  await prisma.chat.deleteMany({ where: { workBranch: 'c-notifytest1' } });
  const branch = await prisma.branch.upsert({
    where: { name: 'notify-test-target' },
    create: { name: 'notify-test-target' },
    update: {},
  });
  const chat = await prisma.chat.create({
    data: {
      branchId: branch.id,
      workBranch: 'c-notifytest1',
      title: 'Rewrite the pricing page',
      createdById: USER,
    },
  });
  chatId = chat.id;
});

beforeEach(async () => {
  sent.length = 0;
  smsShouldThrow = false;
  setEnv({ NOTIFY_SMS_PROVIDER: 'spy', NOTIFY_SMS_FROM: '+15550000000' });
  await prisma.chatNotification.deleteMany({ where: { chatId } });
  await prisma.chat.update({ where: { id: chatId }, data: { turnPhase: 'idle' } });
});

afterEach(() => {
  setEnv({});
});

describe('channel resolution', () => {
  it('offers only channels this deployment configured a provider for', () => {
    expect(configuredChannels()).toEqual(['sms']);
    setEnv({ NOTIFY_SMS_PROVIDER: 'spy', NOTIFY_EMAIL_PROVIDER: 'spy' });
    expect(configuredChannels().sort()).toEqual(['email', 'sms']);
    setEnv({});
    expect(configuredChannels()).toEqual([]);
  });

  it('drops a channel whose provider id is not registered', () => {
    setEnv({ NOTIFY_SMS_PROVIDER: 'no-such-vendor' });
    expect(channelSetup('sms')).toBeNull();
    expect(configuredChannels()).toEqual([]);
  });

  it('refuses to run on unparseable credentials instead of half-configuring', () => {
    setEnv({ NOTIFY_SMS_PROVIDER: 'spy', NOTIFY_SMS_CONFIG: '{not json' });
    expect(channelSetup('sms')).toBeNull();
    // A JSON array parses but is not a credentials object.
    setEnv({ NOTIFY_SMS_PROVIDER: 'spy', NOTIFY_SMS_CONFIG: '["a"]' });
    expect(channelSetup('sms')).toBeNull();
  });

  it('merges NOTIFY_*_FROM into the provider config', async () => {
    setEnv({
      NOTIFY_SMS_PROVIDER: 'spy',
      NOTIFY_SMS_FROM: '+15550000000',
      NOTIFY_SMS_CONFIG: '{"accountSid":"AC1"}',
    });
    await deliver('sms', '+15551230000', { subject: 's', body: 'b', url: 'u' });
    expect(sent[0].config).toMatchObject({ from: '+15550000000', accountSid: 'AC1' });
  });

  it('reads an address per channel and reports when there is none', () => {
    expect(addressFor('email', { email: 'a@b.c', phone: null })).toBe('a@b.c');
    expect(addressFor('sms', { email: 'a@b.c', phone: null })).toBeNull();
    expect(addressFor('sms', { email: 'a@b.c', phone: '  ' })).toBeNull();
  });
});

describe('twilio credentials', () => {
  /**
   * Twilio takes two different credentials over one basic-auth field, and the
   * REST path names the ACCOUNT either way. Signing with an API key while
   * putting the key's own SK… in the URL is a 404 that reads like a bad phone
   * number, so the account sid stays required in both shapes.
   */
  const callTwilio = async (config: Record<string, unknown>) => {
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: (init.headers as Record<string, string>).Authorization,
        body: String(init.body),
      });
      return new Response('', { status: 201 });
    });
    setEnv({
      NOTIFY_SMS_PROVIDER: 'twilio',
      NOTIFY_SMS_FROM: '+15550000000',
      NOTIFY_SMS_CONFIG: JSON.stringify(config),
    });
    try {
      await deliver('sms', '+15551230000', { subject: 'Chat is done', body: 'b', url: 'https://cms/x' });
      return calls[0];
    } finally {
      vi.unstubAllGlobals();
    }
  };

  const decode = (auth: string) => Buffer.from(auth.replace('Basic ', ''), 'base64').toString();

  it('signs with the account auth token when that is what it was given', async () => {
    const call = await callTwilio({ accountSid: 'AC123', authToken: 'tok' });
    expect(call.url).toContain('/Accounts/AC123/Messages.json');
    expect(decode(call.auth)).toBe('AC123:tok');
    // The link is the point of the message, so it always rides along.
    expect(call.body).toContain('Chat+is+done');
    expect(call.body).toContain(encodeURIComponent('https://cms/x'));
  });

  it('signs with an API key pair but still addresses the account', async () => {
    const call = await callTwilio({ accountSid: 'AC123', apiKeySid: 'SK456', apiKeySecret: 'sec' });
    expect(call.url).toContain('/Accounts/AC123/Messages.json');
    expect(decode(call.auth)).toBe('SK456:sec');
  });

  it('names the missing field, and the variable it comes from', async () => {
    setEnv({
      NOTIFY_SMS_PROVIDER: 'twilio',
      NOTIFY_SMS_FROM: '+15550000000',
      NOTIFY_SMS_CONFIG: JSON.stringify({ apiKeySid: 'SK456', apiKeySecret: 'sec' }),
    });
    await expect(
      deliver('sms', '+15551230000', { subject: 's', body: 'b', url: 'u' }),
    ).rejects.toThrow(/accountSid.*NOTIFY_SMS_CONFIG/s);
  });
});

describe('phone normalization', () => {
  it('accepts E.164 however a human spaced it', () => {
    expect(normalizePhone('+49 170 123 45 67')).toBe('+491701234567');
    expect(normalizePhone('+1 (555) 123-0000')).toBe('+15551230000');
  });

  it('rejects anything a provider would reject', () => {
    for (const bad of ['0170123456', '+0123456789', '+49', '+12345678901234567', 'not a number']) {
      expect(normalizePhone(bad)).toBeNull();
    }
  });
});

describe('arming', () => {
  it('round-trips channels and disarms on an empty list', async () => {
    expect(await armedChannels(chatId, USER)).toEqual([]);
    expect(await setArmedChannels(chatId, USER, ['sms', 'email'])).toEqual(['sms', 'email']);
    expect(await armedChannels(chatId, USER)).toEqual(['sms', 'email']);
    // Re-arming replaces rather than accumulates.
    await setArmedChannels(chatId, USER, ['sms']);
    expect(await armedChannels(chatId, USER)).toEqual(['sms']);
    expect(await setArmedChannels(chatId, USER, [])).toEqual([]);
    expect(await armedChannels(chatId, USER)).toEqual([]);
  });
});

describe('firing at the end of a turn', () => {
  it('delivers once and disarms itself', async () => {
    await setArmedChannels(chatId, USER, ['sms']);
    await notifyTurnFinished(chatId);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', to: '+15551230000' });
    expect(sent[0].message.subject).toContain('Rewrite the pricing page');
    expect(sent[0].message.url).toMatch(new RegExp(`/chat/${chatId}$`));

    // The arm is consumed: a second turn ending says nothing.
    expect(await armedChannels(chatId, USER)).toEqual([]);
    await notifyTurnFinished(chatId);
    expect(sent).toHaveLength(1);
  });

  it('says which of the three ways the turn ended', async () => {
    await setArmedChannels(chatId, USER, ['sms']);
    await notifyTurnFinished(chatId, true);
    expect(sent[0].message.subject).toContain('stopped with an error');

    await prisma.chat.update({ where: { id: chatId }, data: { turnPhase: 'waiting_for_answer' } });
    await setArmedChannels(chatId, USER, ['sms']);
    await notifyTurnFinished(chatId);
    expect(sent[1].message.subject).toContain('needs your answer');

    await prisma.chat.update({ where: { id: chatId }, data: { turnPhase: 'idle' } });
    await setArmedChannels(chatId, USER, ['sms']);
    await notifyTurnFinished(chatId);
    expect(sent[2].message.subject).toContain('is done');
  });

  it('writes in the recipient\'s own language, not the sender\'s', async () => {
    await prisma.user.update({ where: { id: USER }, data: { language: 'de' } });
    await setArmedChannels(chatId, USER, ['sms']);
    await notifyTurnFinished(chatId);
    expect(sent[0].message.subject).toContain('ist fertig');
    await prisma.user.update({ where: { id: USER }, data: { language: 'en' } });
  });

  it('skips a channel that lost its provider, and still disarms', async () => {
    await setArmedChannels(chatId, USER, ['email']); // armed while email worked
    setEnv({ NOTIFY_SMS_PROVIDER: 'spy' }); // …then email was unconfigured
    await notifyTurnFinished(chatId);
    expect(sent).toHaveLength(0);
    expect(await armedChannels(chatId, USER)).toEqual([]);
  });

  it('skips a channel the person has no address for', async () => {
    await setArmedChannels(chatId, NO_PHONE_USER, ['sms']);
    await notifyTurnFinished(chatId);
    expect(sent).toHaveLength(0);
  });

  /**
   * The whole point of the fail-soft path: a vendor outage at the end of a
   * long turn must cost a log line, not the turn.
   */
  it('swallows a provider failure and consumes the arm anyway', async () => {
    smsShouldThrow = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setArmedChannels(chatId, USER, ['sms']);
    await expect(notifyTurnFinished(chatId)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(await armedChannels(chatId, USER)).toEqual([]);
    warn.mockRestore();
  });

  it('does nothing at all when nobody armed it', async () => {
    await notifyTurnFinished(chatId);
    expect(sent).toHaveLength(0);
  });
});
