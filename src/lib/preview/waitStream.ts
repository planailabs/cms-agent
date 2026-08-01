/**
 * SSE wait stream for the preview boot page — served from middleware for the
 * same reason as the boot page (underscore paths are excluded from Astro
 * routing). The proxy passes /__preview/* through unrewritten on unrouted
 * preview hosts, so the boot page can subscribe same-origin.
 *
 * Events: `phase` (deps|server, install/start progress), `ready` (route
 * exists — reload lands on the preview), `failed` (start error recorded —
 * reload renders the error page). The stream closes after ready/failed.
 *
 * Driven by the manager's notifications, not by polling: it knows the moment
 * a start moves, and re-reading its maps every 500 ms per waiting browser was
 * work proportional to the audience for something one place already knew. The
 * heartbeat and the backstop timeout stay — a missed edge should end as a
 * timeout, not as a browser waiting forever.
 */
import {
  getStartError,
  getStartPhase,
  listInstances,
  subscribeBranchState,
} from './manager';

export const WAIT_PATH_RE = /^\/__preview\/wait\/([a-z0-9][a-z0-9-]{0,62})\/?$/;

const HEARTBEAT_MS = 15_000;
/** Backstop for streams nothing will ever resolve (branch never started). */
const MAX_STREAM_MS = 10 * 60_000;

const isReady = (branch: string): boolean =>
  listInstances().some((i) => i.branch === branch && i.status === 'ready');

export function handlePreviewWait(branch: string, request: Request): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  // clearInterval clears timeouts too — Node and browsers share the pool
  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  const cleanup = () => {
    unsubscribe();
    timers.forEach((t) => clearInterval(t));
    timers.length = 0;
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
      const send = (event: string, data = '') => enqueue(`event: ${event}\ndata: ${data}\n\n`);
      const finish = (event: string) => {
        send(event);
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      let lastPhase: string | null = null;
      /** The manager's state is the truth; an event is only a reason to look
       *  at it. That keeps ordering mistakes from mattering. */
      const check = () => {
        if (isReady(branch)) return finish('ready');
        if (getStartError(branch)) return finish('failed');
        const phase = getStartPhase(branch);
        if (phase && phase !== lastPhase) {
          lastPhase = phase;
          send('phase', phase);
        }
      };

      // Subscribe BEFORE the first read: a start that finishes in between
      // would otherwise be missed by both.
      unsubscribe = subscribeBranchState((changed) => {
        if (changed === branch) check();
      });
      check();

      timers.push(setInterval(() => enqueue(': ping\n\n'), HEARTBEAT_MS));
      timers.push(setTimeout(() => finish('timeout'), MAX_STREAM_MS));

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
}
