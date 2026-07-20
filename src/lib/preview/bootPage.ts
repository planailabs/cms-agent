/**
 * Boot page for preview hosts, served from MIDDLEWARE — the URL contract
 * with the Pingora sidecar is /__preview/boot/<branch>, and underscore-
 * prefixed paths under src/pages are excluded from Astro routing, so this
 * cannot be a page file.
 *
 * The sidecar rewrites requests for unknown/stopped <branch>.BASE_DOMAIN
 * hosts here; we trigger the instance start and let the browser refresh
 * until the sidecar picks up the new route.
 */
import { prisma } from '@/lib/db';
import { ensureBranch } from '@/lib/git/engine';
import { t } from '@/lib/i18n';
import { ensureInstance, getStartError, clearStartError } from './manager';
import { escapeHtml } from './html';

export const BOOT_PATH_RE = /^\/__preview\/boot\/([a-z0-9][a-z0-9-]{0,62})\/?$/;

/**
 * Redirect target after a retry: the visitor's original path+query (from the
 * sidecar's x-cms-boot-origin header) minus the retry param. Falls back to /
 * for missing/forged values — must be a same-origin path, never the internal
 * boot path itself (parked there, the browser would 404 into the dev server
 * once the route exists).
 */
export function cleanBootOrigin(originHeader: string | null): string {
  if (!originHeader || !originHeader.startsWith('/') || originHeader.startsWith('//')) return '/';
  let u: URL;
  try {
    u = new URL(originHeader, 'http://origin.invalid');
  } catch {
    return '/';
  }
  if (BOOT_PATH_RE.test(u.pathname)) return '/';
  u.searchParams.delete('retry');
  return u.pathname + u.search;
}

export async function handlePreviewBoot(
  branch: string,
  retry = false,
  locale = 'en',
  origin = '/',
): Promise<Response> {
  if (retry) clearStartError(branch);
  // v-<sha> labels are historical read-only checkouts (plan §12)
  const isHistorical = /^v-[0-9a-f]{7,40}$/.test(branch);
  const isMain = branch === 'main';
  const [known, chat] =
    isHistorical || isMain
      ? [null, null]
      : await Promise.all([
          prisma.branch.findUnique({ where: { name: branch } }),
          // per-chat work branches (c-…) get previews too
          prisma.chat.findUnique({
            where: { workBranch: branch },
            include: { branch: { select: { name: true } } },
          }),
        ]);
  const bootable = !!known || !!chat || isMain || isHistorical;
  // A failed start halts the reload loop and is shown until retried.
  const startError = bootable ? getStartError(branch) : null;

  if (bootable && !startError) {
    // Fire and forget — the page refreshes until the route exists.
    void (async () => {
      // A work branch may not exist in git before its first turn
      if (chat) await ensureBranch(branch, chat.branch.name);
      // retry after a failure = repair: force a dependency re-install
      await ensureInstance(branch, retry);
    })().catch((err) => console.error(`[preview] failed to start ${branch}:`, err));
  }

  if (retry && bootable) {
    // The repair start is in flight — bounce back to the visitor's real URL
    // so the refresh loop continues there and lands on the preview once the
    // route exists. Staying on ?retry=1 would force a dependency re-install
    // on every 2s refresh.
    return new Response(null, {
      status: 303,
      headers: { Location: origin, 'Cache-Control': 'no-store' },
    });
  }

  // The branch param is pre-escaped and wrapped here, so interpolation
  // stays HTML-safe.
  const safe = escapeHtml(branch);
  const strong = { branch: `<strong>${safe}</strong>` };
  const body = startError
    ? `<div class="error"><p>${t(locale, 'pages.preview.failed', strong)}</p>` +
      `<pre>${escapeHtml(startError.message)}</pre>` +
      // Relative link: stays on the visitor's URL; the sidecar forwards the
      // query to the boot endpoint, so /__preview/boot is never exposed.
      `<p><a href="?retry=1">${t(locale, 'pages.preview.retry')}</a></p></div>`
    : bootable
      ? `<p class="pulse">${t(locale, 'pages.preview.starting', strong)}</p>`
      : `<p>${t(locale, 'pages.preview.unknownBranch', strong)}</p>`;

  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
  <head>
    <meta charset="utf-8" />
    ${bootable && !startError ? '<meta http-equiv="refresh" content="2" />' : ''}
    <title>${t(locale, startError ? 'pages.preview.failedTitle' : 'pages.preview.startingTitle')}</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
        background: #0b0d10;
        color: #e6e8ea;
      }
      .pulse { animation: pulse 1.2s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.4; } }
      .error { max-width: 60rem; padding: 1rem; }
      .error pre { white-space: pre-wrap; background: #14181d; padding: 1rem; overflow: auto; }
      .error a { color: #7ab7ff; }
    </style>
  </head>
  <body>${body}</body>
</html>`;

  return new Response(html, {
    status: startError ? 502 : bootable ? 200 : 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
