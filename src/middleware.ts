/**
 * Auth middleware — attaches locals.user/session, enforces the email
 * allowlist on every request (covers users removed after sign-up), guards
 * API routes, and keeps the preview-host cookie fresh.
 */
import { defineMiddleware } from 'astro:middleware';
import { auth } from '@/lib/auth';
import { isEmailAllowed } from '@/lib/allowlist';
import {
  issuePreviewCookie,
  previewCookieAttributes,
  PREVIEW_COOKIE_NAME,
} from '@/lib/previewCookie';

const PUBLIC_PATHS = [/^\/api\/auth\//, /^\/signin\/?$/, /^\/preview-overlay\.js$/, /^\/_astro\//, /^\/favicon/];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

  const session = await auth.api.getSession({ headers: context.request.headers });

  if (session && isEmailAllowed(session.user.email)) {
    context.locals.user = session.user;
    context.locals.session = session.session;
  } else {
    context.locals.user = null;
    context.locals.session = null;
  }

  const isPublic = PUBLIC_PATHS.some((re) => re.test(pathname));

  if (!context.locals.user && !isPublic) {
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return context.redirect('/signin/');
  }

  const response = await next();

  // Refresh the preview-host cookie for signed-in editors (verified by the
  // Pingora sidecar on <branch>.BASE_DOMAIN requests).
  if (context.locals.user && !context.cookies.get(PREVIEW_COOKIE_NAME)) {
    const { value, expiresAt } = issuePreviewCookie(context.locals.user.id);
    response.headers.append(
      'Set-Cookie',
      `${PREVIEW_COOKIE_NAME}=${value}; ${previewCookieAttributes(expiresAt)}`,
    );
  }

  return response;
});
