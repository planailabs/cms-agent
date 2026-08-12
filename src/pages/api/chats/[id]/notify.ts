/**
 * GET  /api/chats/:id/notify — what this viewer can be notified on, and what
 *                              they have armed for this chat.
 * PUT  /api/chats/:id/notify — arm exactly these channels ([] disarms), and
 *                              optionally save the phone number SMS needs.
 *
 * The phone number rides along with the arm request on purpose: "notify me by
 * SMS" and "here is my number" are one intention, and splitting them into two
 * round trips is how a modal ends up armed for a channel it cannot deliver on.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';
import { addressFor, configuredChannels, normalizePhone, isNotifyChannel } from '@/lib/notify';
import { armedChannels, setArmedChannels } from '@/lib/notify/chatNotify';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** 404 unless the chat exists and this viewer may see it. */
async function requireChat(chatId: string, user: { id: string; role: string }) {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { id: true, createdById: true },
  });
  if (!chat) return { denied: json({ error: 'Chat not found' }, 404) };
  const denied = await chatAccessDenied(user, chat);
  return denied ? { denied } : { chat };
}

/**
 * One shape for both verbs, so the client applies the server's answer instead
 * of the request it hoped for. `available` is what this deployment configured;
 * `missingAddress` is which of those this person has no address on yet — the
 * modal needs the difference to explain why SMS is greyed out.
 */
async function stateFor(chatId: string, userId: string) {
  const profile = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, phone: true },
  });
  const available = configuredChannels();
  return json({
    channels: await armedChannels(chatId, userId),
    available,
    missingAddress: available.filter((c) => !addressFor(c, profile)),
    phone: profile.phone,
    email: profile.email,
  });
}

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user!;
  const { denied } = await requireChat(params.id!, user);
  if (denied) return denied;
  return stateFor(params.id!, user.id);
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  const { denied } = await requireChat(params.id!, user);
  if (denied) return denied;

  let body: { channels?: unknown; phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!Array.isArray(body.channels) || !body.channels.every(isNotifyChannel)) {
    return json({ error: 'channels must be an array of "email" | "sms"' }, 400);
  }

  // Empty string clears a saved number; anything else must be a number a
  // provider will actually accept, and the caller hears about it if it isn't.
  if (typeof body.phone === 'string') {
    const trimmed = body.phone.trim();
    if (trimmed === '') {
      await prisma.user.update({ where: { id: user.id }, data: { phone: null } });
    } else {
      const phone = normalizePhone(trimmed);
      if (!phone) return json({ error: 'Phone number must be in international format, e.g. +49170…' }, 400);
      await prisma.user.update({ where: { id: user.id }, data: { phone } });
    }
  }

  // Arming a channel this person has no address on is silence, not a
  // notification — and silence is exactly what somebody who armed a bell
  // will not investigate. Refuse it while there is still a form open to fix
  // it in. (Email always has one; this is really about SMS with no number.)
  const profile = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { email: true, phone: true },
  });
  const unreachable = body.channels.filter((c) => !addressFor(c, profile));
  if (unreachable.length > 0) {
    return json({ error: `No address for: ${unreachable.join(', ')}` }, 400);
  }

  await setArmedChannels(params.id!, user.id, body.channels);
  return stateFor(params.id!, user.id);
};
