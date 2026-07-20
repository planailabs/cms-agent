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
  verifyPreviewCookie,
  PREVIEW_COOKIE_NAME,
} from '@/lib/previewCookie';
import { BOOT_PATH_RE, cleanBootOrigin, handlePreviewBoot } from '@/lib/preview/bootPage';
import { initRoutesFile } from '@/lib/preview/manager';
import { getInternalToken } from '@/lib/internalToken';
import { env } from '@/lib/env';

// Publish the sidecar routing table, create the shared internal token and
// recover automatisms orphaned by the previous process, once per server boot
// (skipped when the module is loaded outside a configured runtime, e.g.
// during astro build).
if (process.env.VAR_DIR) {
  initRoutesFile();
  try {
    getInternalToken();
  } catch (err) {
    console.error('[internal] failed to create internal token:', err);
  }
  void import('@/lib/automatism')
    .then(({ recoverAutomatisms }) => recoverAutomatisms())
    .catch((err) => console.error('[automatism] boot recovery failed:', err));
}

const PUBLIC_PATHS = [
  /^\/api\/auth\//,
  /^\/signin\/?$/,
  /^\/_astro\//,
  /^\/favicon/,
];

// Paths that need no session and manage their own auth (the injected-agent
// bundles are public by design; /api/internal/ is Bearer-token checked in its
// handler). Skipped BEFORE env()/session work — the injected endpoints are
// prerendered, and during `astro build` there is no runtime env to validate.
const SELF_AUTHENTICATING_PATHS = [
  /^\/injected-cms-agent\.js$/,
  /^\/injected-agent-module\.js$/,
  /^\/api\/internal\//,
];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

  if (SELF_AUTHENTICATING_PATHS.some((re) => re.test(pathname))) {
    context.locals.user = null;
    context.locals.session = null;
    return next();
  }

  if (env().SKIP_AUTH) {
    // Development mode: no sign-in; identity from the seeded dev users,
    // switchable via the impersonation cookie (POST /api/dev/impersonate).
    const { getDevUser, DEV_IMPERSONATE_COOKIE } = await import('@/lib/devAuth');
    context.locals.user = await getDevUser(context.cookies.get(DEV_IMPERSONATE_COOKIE)?.value);
    context.locals.session = null;
  } else {
    const session = await auth.api.getSession({ headers: context.request.headers });

    if (session && isEmailAllowed(session.user.email)) {
      context.locals.user = session.user;
      context.locals.session = session.session;
    } else {
      context.locals.user = null;
      context.locals.session = null;
    }
  }

  // Preview boot page — served here because underscore-prefixed src/pages
  // paths are excluded from Astro routing; the sidecar's rewrite target
  // (/__preview/boot/<branch>) is a fixed contract. Auth: CMS session or the
  // sidecar's HMAC preview cookie (requests arrive from preview hosts where
  // the better-auth cookie doesn't exist).
  const bootMatch = BOOT_PATH_RE.exec(pathname);
  if (bootMatch) {
    const url = new URL(context.request.url);
    // Direct hits on the CMS host would refresh-loop on this internal URL
    // forever (the CMS always serves the boot page here) — send the browser
    // to the real preview host, where the sidecar handles booting without
    // exposing this path. Sidecar-rewritten requests keep the preview Host.
    const reqHost = (context.request.headers.get('host') ?? url.host)
      .replace(/:\d+$/, '')
      .toLowerCase();
    if (reqHost === env().BASE_DOMAIN.toLowerCase()) {
      const scheme =
        env().PUBLIC_SCHEME ?? (url.protocol === 'https:' ? 'https' : 'http');
      const hostWithPort = context.request.headers.get('host') ?? url.host;
      return context.redirect(`${scheme}://${bootMatch[1]}.${hostWithPort}/`);
    }
    const previewCookie = context.cookies.get(PREVIEW_COOKIE_NAME)?.value;
    const previewAuth = previewCookie ? verifyPreviewCookie(previewCookie) : null;
    if (!context.locals.user && !previewAuth) {
      return context.redirect('/signin/');
    }
    const retry = url.searchParams.has('retry');
    // Locale: the signed-in editor's language; preview-cookie visitors have
    // no user, so negotiate from Accept-Language (as on the sign-in page).
    const locale =
      context.locals.user?.language ??
      (/(^|[,;\s])de\b/i.test(context.request.headers.get('accept-language') ?? '') ? 'de' : 'en');
    const origin = cleanBootOrigin(context.request.headers.get('x-cms-boot-origin'));
    return handlePreviewBoot(bootMatch[1], retry, locale, origin);
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
