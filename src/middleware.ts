/**
 * Auth middleware — attaches locals.user/session, enforces the email
 * allowlist on every request (covers users removed after sign-up), guards
 * API routes, including preview subdomains through Better Auth's shared cookie.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineMiddleware } from 'astro:middleware';
import { auth, COOKIE_SCOPE_MARKER, sessionCookieMigrationHeaders } from '@/lib/auth';
import { isEmailAllowed } from '@/lib/allowlist';
import { BOOT_PATH_RE, cleanBootOrigin, handlePreviewBoot } from '@/lib/preview/bootPage';
import { WAIT_PATH_RE, handlePreviewWait } from '@/lib/preview/waitStream';
import { currentRoutesJson, initRoutesFile } from '@/lib/preview/manager';
import { startEmbeddedProxy, updateProxySession } from '@/lib/proxyNative';
import { isFromProxy, proxyRequiredResponse } from '@/lib/proxyGuard';
import { env } from '@/lib/env';

// Publish the routing table, start the embedded proxy, and recover automatisms
// orphaned by the previous process, once per server boot
// (skipped when the module is loaded outside a configured runtime, e.g.
// during astro build).
if (process.env.VAR_DIR) {
  initRoutesFile();
  // Legacy scratchpad storage (pre-.scratch/-in-worktree) — drop it once.
  fs.rmSync(path.join(path.resolve(process.env.VAR_DIR), 'scratch'), {
    recursive: true,
    force: true,
  });
  const proxyStartedByServer = Boolean(
    (globalThis as typeof globalThis & { __nativeProxy?: { started?: boolean } }).__nativeProxy
      ?.started,
  );
  if (proxyStartedByServer || (import.meta.env.DEV && !process.env.VITEST)) {
    startEmbeddedProxy(currentRoutesJson());
  }
  void import('@/lib/automatism')
    .then(({ recoverAutomatisms }) => recoverAutomatisms())
    .catch((err) => console.error('[automatism] boot recovery failed:', err));
  // Branches chats fork from stay warm — their previews are what a draft
  // chat shows, and nobody should wait for a dev server to boot to see one.
  void import('@/lib/preview/prewarm')
    .then(({ startPrimaryBranchWarmer }) => startPrimaryBranchWarmer())
    .catch((err) => console.error('[prewarm] warmer failed to start:', err));
  // Worktrees and sandbox homes of chats that no longer exist are pure disk
  // cost (a checkout plus a private npm cache each) — reconcile hourly.
  void import('@/lib/worktreeCleanup')
    .then(({ startOrphanSweeper }) => startOrphanSweeper())
    .catch((err) => console.error('[cleanup] sweeper failed to start:', err));
}

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
