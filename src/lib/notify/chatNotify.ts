/**
 * "Tell me when this chat stops working."
 *
 * A turn can run for many minutes, and the person who started it is usually
 * somewhere else by the time it ends. Arming a chat records who wants to know
 * and on which channels; the turn's own exit path fires it.
 *
 * One-shot by construction: the row is deleted the moment it fires. The
 * alternative — a standing subscription — texts somebody on every turn of a
 * conversation they came back to hours ago, and the cost of that mistake is
 * measured in SMS charges, not in log lines.
 */
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { t } from '@/lib/i18n';
import { addressFor, channelSetup, deliver, isNotifyChannel, type NotifyChannelId } from './index';

/** Why the turn stopped — what the person is actually being told. */
export type TurnOutcome = 'done' | 'question' | 'error';

const SUBJECT_KEY: Record<TurnOutcome, string> = {
  done: 'chat.notify.subject.done',
  question: 'chat.notify.subject.question',
  error: 'chat.notify.subject.error',
};
const BODY_KEY: Record<TurnOutcome, string> = {
  done: 'chat.notify.body.done',
  question: 'chat.notify.body.question',
  error: 'chat.notify.body.error',
};

/** Stored as JSON — validate on the way out, not just on the way in. */
const readChannels = (value: unknown): NotifyChannelId[] =>
  Array.isArray(value) ? value.filter(isNotifyChannel) : [];

/** Channels this user has armed for this chat (empty = not armed). */
export async function armedChannels(chatId: string, userId: string): Promise<NotifyChannelId[]> {
  const row = await prisma.chatNotification.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { channels: true },
  });
  return readChannels(row?.channels);
}

/**
 * Arm (or re-arm) with exactly these channels; an empty list disarms.
 * Returns what is armed now, so the caller renders the server's answer rather
 * than the request it hoped for.
 */
export async function setArmedChannels(
  chatId: string,
  userId: string,
  channels: NotifyChannelId[],
): Promise<NotifyChannelId[]> {
  const wanted = [...new Set(channels.filter(isNotifyChannel))];
  if (wanted.length === 0) {
    await prisma.chatNotification.deleteMany({ where: { chatId, userId } });
    return [];
  }
  await prisma.chatNotification.upsert({
    where: { chatId_userId: { chatId, userId } },
    create: { chatId, userId, channels: wanted },
    update: { channels: wanted },
  });
  return wanted;
}

/** Deep link back to the chat, on the public origin (BETTER_AUTH_URL). */
const chatUrl = (chatId: string): string =>
  `${env().BETTER_AUTH_URL.replace(/\/+$/, '')}/chat/${chatId}`;

/**
 * Fire every armed notification for a finished turn and disarm them.
 *
 * Fail-soft in every direction: a provider outage, a missing credential or a
 * number the vendor rejects must not turn a completed turn into a failed one.
 * Failures are logged and the arm is still consumed — the run it was armed
 * for is over either way, and retrying a notification about a turn that
 * already ended just delivers it late.
 */
export async function notifyTurnFinished(chatId: string, failed = false): Promise<void> {
  const rows = await prisma.chatNotification.findMany({
    where: { chatId },
    include: {
      user: { select: { id: true, email: true, phone: true, language: true, name: true } },
    },
  });
  if (rows.length === 0) return;

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { title: true, turnPhase: true },
  });
  if (!chat) return;

  const outcome: TurnOutcome = failed
    ? 'error'
    : chat.turnPhase === 'waiting_for_answer'
      ? 'question'
      : 'done';
  const url = chatUrl(chatId);

  await Promise.all(
    rows.map(async (row) => {
      const locale = row.user.language || 'en';
      const params = { title: chat.title };
      const message = {
        subject: t(locale, SUBJECT_KEY[outcome], params),
        body: t(locale, BODY_KEY[outcome], params),
        url,
      };
      for (const channel of readChannels(row.channels)) {
        const to = addressFor(channel, row.user);
        if (!to || !channelSetup(channel)) continue;
        try {
          await deliver(channel, to, message);
        } catch (err) {
          console.warn(
            `[notify] ${channel} to user ${row.user.id} for chat ${chatId} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      await prisma.chatNotification.deleteMany({ where: { id: row.id } });
    }),
  );
}
