/**
 * POST /api/chat/context — live user-context beacon from the workspace/overlay.
 * Body: { chatId, url?, route? }. Read by the get_user_context tool.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { updateUserContext } from '@/lib/agent/userContext';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  let body: { chatId?: string; url?: string; route?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  if (!body.chatId) {
    return new Response(JSON.stringify({ error: 'chatId required' }), { status: 400 });
  }
  updateUserContext(body.chatId, user.id, {
    userName: user.name,
    url: body.url,
    route: body.route,
  });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
