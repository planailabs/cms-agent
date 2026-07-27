/**
 * Global app settings (admin only).
 * GET → current values ; PUT { attachmentsOnePerMessage?, chatsSharedVisibility? } → update.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { requireAdmin } from '@/lib/adminGuard';
import { getAttachmentsOnePerMessage, getChatsSharedVisibility, setBool, SETTING_KEYS } from '@/lib/settings';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  return json({
    attachmentsOnePerMessage: await getAttachmentsOnePerMessage(),
    chatsSharedVisibility: await getChatsSharedVisibility(),
  });
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  let body: { attachmentsOnePerMessage?: boolean; chatsSharedVisibility?: boolean };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (typeof body.attachmentsOnePerMessage === 'boolean') {
    await setBool(SETTING_KEYS.attachmentsOnePerMessage, body.attachmentsOnePerMessage);
  }
  if (typeof body.chatsSharedVisibility === 'boolean') {
    await setBool(SETTING_KEYS.chatsSharedVisibility, body.chatsSharedVisibility);
  }
  return json({
    ok: true,
    attachmentsOnePerMessage: await getAttachmentsOnePerMessage(),
    chatsSharedVisibility: await getChatsSharedVisibility(),
  });
};
