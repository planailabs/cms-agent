/**
 * POST /api/preview/restart — restart the dev server behind a chat's preview.
 * Body: { chatId }
 *
 * The editor-facing counterpart of the admin action: a preview that wedged
 * (a dev server that stopped recompiling, a dependency added outside it) is
 * something the person looking at it should be able to fix without an admin.
 * Scoped to the chat's OWN work branch — the target branch preview is shared
 * with everyone else's chats, so it is not this button's to bounce.
 *
 * Fire-and-forget like the admin route: the browser reloads the frame, which
 * hits the boot page and waits there while the server comes back up.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';
import { clearStartError, ensureInstance, stopInstance } from '@/lib/preview/manager';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  let body: { chatId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.chatId) return json({ error: 'Invalid body: need { chatId }' }, 400);

  const chat = await prisma.chat.findUnique({
    where: { id: body.chatId },
    select: { workBranch: true, archivedAt: true, createdById: true },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  const denied = await chatAccessDenied(locals.user!, chat);
  if (denied) return denied;

  await stopInstance(chat.workBranch);
  clearStartError(chat.workBranch);
  // Start it again in the background: the boot page the reload lands on shows
  // the progress, and waiting for a dev server here would time the request out.
  void ensureInstance(chat.workBranch).catch((err) =>
    console.error(`[preview] restart of ${chat.workBranch} failed:`, err),
  );
  return json({ status: 'restarting', branch: chat.workBranch }, 202);
};
