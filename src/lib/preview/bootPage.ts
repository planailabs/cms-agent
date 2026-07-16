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
import { ensureInstance } from './manager';
import { escapeHtml } from './html';

export const BOOT_PATH_RE = /^\/__preview\/boot\/([a-z0-9][a-z0-9-]{0,62})\/?$/;

export async function handlePreviewBoot(branch: string): Promise<Response> {
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

  if (bootable) {
    // Fire and forget — the page refreshes until the route exists.
    void (async () => {
      // A work branch may not exist in git before its first turn
      if (chat) await ensureBranch(branch, chat.branch.name);
      await ensureInstance(branch);
    })().catch((err) => console.error(`[preview] failed to start ${branch}:`, err));
  }

  const safe = escapeHtml(branch);
  const body = bootable
    ? `<p class="pulse">Starting preview for <strong>${safe}</strong> — this page reloads automatically…</p>`
    : `<p>Unknown branch <strong>${safe}</strong>.</p>`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    ${bootable ? '<meta http-equiv="refresh" content="2" />' : ''}
    <title>Starting preview…</title>
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
    </style>
  </head>
  <body>${body}</body>
</html>`;

  return new Response(html, {
    status: bootable ? 200 : 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
