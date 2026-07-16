/**
 * GET /api/internal/proxy-events — SSE stream for the proxy sidecar.
 * Authenticated with the shared internal token (Bearer; see
 * src/lib/internalToken.ts — the CMS creates VAR_DIR/internal-token, the
 * proxy reads the same file). Sends the full routing table immediately and
 * again on every change, plus comment heartbeats so dead connections are
 * detected. The proxy reconnects with backoff (see proxy/src/sse.rs).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { verifyInternalRequest } from '@/lib/internalToken';
import { currentRoutesJson, subscribeRoutes } from '@/lib/preview/manager';

const HEARTBEAT_MS = 15_000;

export const GET: APIRoute = ({ request }) => {
  if (!verifyInternalRequest(request)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(); // controller already closed (client gone)
        }
      };
      const send = (event: string, data: string) => enqueue(`event: ${event}\ndata: ${data}\n\n`);

      send('routes', currentRoutesJson());
      unsubscribe = subscribeRoutes((json) => send('routes', json));
      heartbeat = setInterval(() => enqueue(': ping\n\n'), HEARTBEAT_MS);

      request.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};
