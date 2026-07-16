/**
 * SKIP_AUTH mode only: switch between the seeded dev users.
 * POST { email } — one of admin@localhost, user@localhost, user2@localhost.
 * GET — list the seeded users and the active one.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from '@/lib/env';
import { DEV_IMPERSONATE_COOKIE, DEV_USERS } from '@/lib/devAuth';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  if (!env().SKIP_AUTH) return json({ error: 'Not available' }, 404);
  return json({ users: DEV_USERS, active: locals.user?.email });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!env().SKIP_AUTH) return json({ error: 'Not available' }, 404);
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!DEV_USERS.some((u) => u.email === body.email)) {
    return json({ error: `email must be one of: ${DEV_USERS.map((u) => u.email).join(', ')}` }, 400);
  }
  cookies.set(DEV_IMPERSONATE_COOKIE, body.email!, { path: '/', httpOnly: true, sameSite: 'lax' });
  return json({ ok: true, active: body.email });
};
