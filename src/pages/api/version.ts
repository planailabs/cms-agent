/**
 * GET /api/version — the running build's commit + version, for the update
 * watcher (appUpdate.ts): a tab compares this against its baked-in APP_COMMIT
 * to detect a redeploy and reload itself.
 *
 * Logged-in only: the exact build commit is version-pinning info that helps
 * target known exploits, so it must not leak to anonymous callers. The
 * middleware already 401s unauthenticated /api/*; this guard is defence in
 * depth. no-store so it reflects the server answering right now, not a cache.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { APP_COMMIT, APP_VERSION } from '@/components/chat/constants';

export const GET: APIRoute = ({ locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ version: APP_VERSION, commit: APP_COMMIT }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
