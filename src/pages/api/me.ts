import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import {
  isCommunicationModePreference,
  resolveCommunicationMode,
} from '@/lib/communicationMode';
import { env } from '@/lib/env';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!; // middleware guarantees auth on /api/*
  const { getAttachmentsOnePerMessage } = await import('@/lib/settings');
  const profile = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { communicationMode: true },
  });
  const defaultCommunicationMode = env().DEFAULT_COMMUNICATION_MODE;
  return new Response(
    JSON.stringify({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      theme: user.theme,
      language: user.language,
      communicationMode: profile.communicationMode,
      defaultCommunicationMode,
      effectiveCommunicationMode: resolveCommunicationMode(
        profile.communicationMode,
        defaultCommunicationMode,
      ),
      attachmentsOnePerMessage: await getAttachmentsOnePerMessage(),
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};

/** PATCH /api/me — user preferences. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  let body: { theme?: string; language?: string; communicationMode?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const data: Record<string, string> = {};
  if (body.theme && ['light', 'dark', 'system'].includes(body.theme)) data.theme = body.theme;
  if (body.language && /^[a-z]{2}$/.test(body.language)) data.language = body.language;
  if (isCommunicationModePreference(body.communicationMode)) {
    data.communicationMode = body.communicationMode;
  }
  if (Object.keys(data).length === 0) {
    return new Response(JSON.stringify({ error: 'Nothing to update' }), { status: 400 });
  }
  await prisma.user.update({ where: { id: user.id }, data });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
