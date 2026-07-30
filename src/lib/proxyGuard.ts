/**
 * Front-door guard: the app answers only what came through the proxy.
 *
 * The node server listens on PORT for the pingora proxy in front of it, which
 * is what terminates the public traffic, routes preview subdomains and injects
 * the overlay. A request that reaches PORT directly skipped all of that — it
 * is either a misconfigured client or someone poking at the container — and
 * the answer it deserves is a pointer to the real address, not a page.
 *
 * This holds in development too. `astro dev` on PORT serves a CMS that cannot
 * route a preview host or inject the overlay — reaching it directly produces a
 * half-working workspace whose failures look like application bugs. Better to
 * be told the address that works.
 *
 * The proxy stamps X-Cms-Proxy with a token derived from BETTER_AUTH_SECRET,
 * which both sides already hold, and REPLACES any value the client sent, so
 * the header cannot be forged through the proxy itself. Deriving rather than
 * sending the secret keeps it out of upstream request logs. The mirror of
 * this lives in proxy/src/lib.rs — proxy_token() there, PROXY_TOKEN_VECTOR in
 * both test suites pins the two implementations to the same string.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

export const PROXY_HEADER = 'x-cms-proxy';

/** Domain separator — the token is useless for anything but this check. */
const TOKEN_MESSAGE = 'cms-proxy';

export const proxyToken = (secret: string): string =>
  createHmac('sha256', secret).update(TOKEN_MESSAGE).digest('hex');

export function isFromProxy(headers: Headers, secret: string): boolean {
  const sent = headers.get(PROXY_HEADER);
  if (!sent) return false;
  const expected = proxyToken(secret);
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The address the client should have used. The listener's port belongs in it
 * only where the browser really reaches the proxy on that port — the same
 * DEV_PORT_CARRY signal the workspace uses to build preview URLs. Behind a
 * TLS terminator the public address carries no port at all.
 */
export function proxyEntrypoint(): string {
  const e = env();
  const scheme = e.PUBLIC_SCHEME ?? (e.BASE_DOMAIN === 'localhost' ? 'http' : 'https');
  const carry = /^(1|true)$/i.test(process.env.DEV_PORT_CARRY ?? '');
  const port = carry ? process.env.PROXY_LISTEN?.split(':').pop() : undefined;
  return `${scheme}://${e.BASE_DOMAIN}${port ? `:${port}` : ''}/`;
}

/** 403 with the address that does work — as JSON for the API, else as text. */
export function proxyRequiredResponse(pathname: string): Response {
  const entrypoint = proxyEntrypoint();
  const note = `This CMS is served through its proxy. Visit ${entrypoint} instead of this port.`;
  return pathname.startsWith('/api/')
    ? new Response(JSON.stringify({ error: note, entrypoint }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    : new Response(`${note}\n`, {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
}
