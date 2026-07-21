/**
 * GET /api/version — the running build's commit + version. A tab compares
 * this against its own baked-in APP_COMMIT to detect a redeploy and reload
 * itself (see appUpdate.ts). Public + cache-busting: it must reflect the
 * server that answers right now, not a CDN copy.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { APP_COMMIT, APP_VERSION } from '@/components/chat/constants';

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ version: APP_VERSION, commit: APP_COMMIT }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
