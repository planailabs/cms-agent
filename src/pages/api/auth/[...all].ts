/**
 * Better Auth's own routes (sign-in, callback, sign-out, …).
 *
 * Sign-out is wrapped: Better Auth deletes the session row, and the embedded
 * proxy holds its own copy of the active tokens. Without telling it, a
 * signed-out cookie kept opening preview subdomains until the next
 * reconciliation tick — a revocation delay measured by a polling interval.
 */
import type { APIRoute } from 'astro';
import { auth } from '@/lib/auth';
import { revokeProxySession } from '@/lib/proxyNative';

export const ALL: APIRoute = async (ctx) => {
  // Match the PATH, not the URL: a callback carrying ?redirect=/sign-out is
  // not a sign-out, and revoking there would sign the user out mid-login.
  const isSignOut = new URL(ctx.request.url).pathname.endsWith('/sign-out');
  // Read the token BEFORE the handler runs: signing out clears the cookie.
  const token = isSignOut
    ? ((await auth.api.getSession({ headers: ctx.request.headers }))?.session.token ?? null)
    : null;
  const response = await auth.handler(ctx.request);
  if (token && response.ok) revokeProxySession(token);
  return response;
};
