/**
 * Global app settings (admin only).
 * GET → current values ; PUT { attachmentsOnePerMessage } → update.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { requireAdmin } from '@/lib/adminGuard';
import { getAttachmentsOnePerMessage, setBool, SETTING_KEYS } from '@/lib/settings';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  return json({ attachmentsOnePerMessage: await getAttachmentsOnePerMessage() });
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  let body: { attachmentsOnePerMessage?: boolean };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (typeof body.attachmentsOnePerMessage === 'boolean') {
    await setBool(SETTING_KEYS.attachmentsOnePerMessage, body.attachmentsOnePerMessage);
  }
  return json({ ok: true, attachmentsOnePerMessage: await getAttachmentsOnePerMessage() });
};
