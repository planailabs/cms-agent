/**
 * Auth middleware — attaches locals.user/session, enforces the email
 * allowlist on every request (covers users removed after sign-up), guards
 * API routes, including preview subdomains through Better Auth's shared cookie.
 */
import { defineMiddleware } from 'astro:middleware';
import { auth, COOKIE_SCOPE_MARKER, sessionCookieMigrationHeaders } from '@/lib/auth';
import { isEmailAllowed } from '@/lib/allowlist';
import { BOOT_PATH_RE, cleanBootOrigin, handlePreviewBoot } from '@/lib/preview/bootPage';
import { WAIT_PATH_RE, handlePreviewWait } from '@/lib/preview/waitStream';
import { currentRoutesJson } from '@/lib/preview/manager';
import { updateProxySession } from '@/lib/proxyNative';
import { startRuntimeServices } from '@/lib/serverRuntime';
import { isFromProxy, proxyRequiredResponse } from '@/lib/proxyGuard';
import { env } from '@/lib/env';

// Start what a booting server owns (lib/serverRuntime).
//
// Gated on a server actually booting, not merely on a configured environment:
// `astro build` evaluates this module to prerender pages, and dotenv (via
// lib/env) fills VAR_DIR in from .env there too — so this would run inside the
// build, where the preview warmer has no sandbox to start previews in and
// logged its failure on every build. server.mjs publishes the proxy marker
// before it imports the SSR entry, and `astro dev` is the other real runtime;
// nothing else here is a server.
const proxyStartedByServer = Boolean(
  (globalThis as typeof globalThis & { __nativeProxy?: { started?: boolean } }).__nativeProxy
    ?.started,
);
const isServerBoot = proxyStartedByServer || (import.meta.env.DEV && !process.env.VITEST);
if (process.env.VAR_DIR && isServerBoot) startRuntimeServices();

const PUBLIC_PATHS = [
  /^\/api\/auth\//,
  /^\/signin\/?$/,
  /^\/_astro\//,
  /^\/favicon/,
  // Architecture reference and its guides: checked-in prose about the design,
  // nothing about this deployment (see src/components/architecture/index.ts).
  /^\/architecture(\/|$)/,
];

// The injected-agent bundles are public by design. Skip them before env/session
// work because they are prerendered without a configured runtime.
const SELF_AUTHENTICATING_PATHS = [
  /^\/injected-cms-agent\.js$/,
  /^\/injected-agent-module\.js$/,
  /^\/injected-annotate\.js$/,
];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = new URL(context.request.url);

  // Prerendered routes run at BUILD time, where there is no proxy and no real
  // request — and are served as static files at runtime, which never reach
  // this middleware at all. Without this the guard's own response is baked
  // into the build output: the injected-agent bundles shipped as an 84-byte
  // "visit the proxy" note, and the overlay was dead on every preview.
  if (context.isPrerendered) return next();

  // Front door first: everything below assumes the proxy already routed,
  // authorized the preview host and rewrote the path. A request that reached
  // this port directly gets the public address instead of a page.
  if (!isFromProxy(context.request.headers, env().BETTER_AUTH_SECRET)) {
    return proxyRequiredResponse(pathname);
  }

  if (SELF_AUTHENTICATING_PATHS.some((re) => re.test(pathname))) {
    context.locals.user = null;
    context.locals.session = null;
    return next();
  }

  let cookieMigration: string[] | null = null;
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
      updateProxySession(session.session);
      // Sessions from before crossSubDomainCookies have a host-only cookie
      // that never reaches preview subdomains — migrate it once per browser.
      if (context.cookies.get(COOKIE_SCOPE_MARKER)?.value !== '1') {
        cookieMigration = sessionCookieMigrationHeaders(
          session.session.token,
          session.session.expiresAt,
        );
      }
    } else {
      context.locals.user = null;
      context.locals.session = null;
    }
  }

  // Preview boot page — served here because underscore-prefixed src/pages
  // paths are excluded from Astro routing; the proxy's rewrite target
  // (/__preview/boot/<branch>) is a fixed contract. Preview hosts receive the
  // same Better Auth session cookie used by the CMS.
  // SSE wait stream for the boot page (same auth as the boot page itself).
  const waitMatch = WAIT_PATH_RE.exec(pathname);
  if (waitMatch) {
    if (!context.locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handlePreviewWait(waitMatch[1], context.request);
  }

  const bootMatch = BOOT_PATH_RE.exec(pathname);
  if (bootMatch) {
    const url = new URL(context.request.url);
    // Direct hits on the CMS host would refresh-loop on this internal URL
    // forever (the CMS always serves the boot page here) — send the browser
    // to the real preview host, where the proxy handles booting without
    // exposing this path. Proxy-rewritten requests keep the preview Host.
    const reqHost = (context.request.headers.get('host') ?? url.host)
      .replace(/:\d+$/, '')
      .toLowerCase();
    if (reqHost === env().BASE_DOMAIN.toLowerCase()) {
      const scheme =
        env().PUBLIC_SCHEME ?? (url.protocol === 'https:' ? 'https' : 'http');
      const hostWithPort = context.request.headers.get('host') ?? url.host;
      return context.redirect(`${scheme}://${bootMatch[1]}.${hostWithPort}/`);
    }
    if (!context.locals.user) {
      return context.redirect('/signin/');
    }
    const retry = url.searchParams.has('retry');
    // Locale follows the signed-in editor, with Accept-Language as fallback.
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
    // Carry the deep link (e.g. /chat/<id>?window=git) through the signin
    // round trip; signin validates it before using it as the OAuth callback.
    const next_ = pathname + search;
    return context.redirect(
      next_ === '/' ? '/signin/' : `/signin/?next=${encodeURIComponent(next_)}`,
    );
  }

  const response = await next();
  if (cookieMigration) {
    for (const header of cookieMigration) response.headers.append('Set-Cookie', header);
  }
  return response;
});
