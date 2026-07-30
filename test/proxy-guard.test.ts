/**
 * Front-door guard: the CMS answers only requests the pingora proxy forwarded.
 *
 * The token is computed independently in two languages — proxy/src/auth.rs
 * stamps it, src/lib/proxyGuard.ts checks it — so the vector below is the
 * contract between them. proxy/src/auth.rs asserts the SAME pair; if one side
 * drifts, the CMS stops accepting the proxy's traffic entirely, and these two
 * tests are what say so before a deploy does.
 */
import { describe, expect, it } from 'vitest';
import {
  PROXY_HEADER,
  isFromProxy,
  proxyRequiredResponse,
  proxyToken,
} from '@/lib/proxyGuard';

const SECRET = 'proxy-guard-test-secret';
const PROXY_TOKEN_VECTOR = 'e9f2f9ca5aeaab408356cbae9972bf8414a656f13788758c84ca142ad54ecddc';

const headers = (value?: string) => new Headers(value ? { [PROXY_HEADER]: value } : {});

describe('proxy guard', () => {
  it('derives the same token the Rust proxy stamps', () => {
    expect(proxyToken(SECRET)).toBe(PROXY_TOKEN_VECTOR);
  });

  it('accepts the proxy and rejects everything else', () => {
    expect(isFromProxy(headers(PROXY_TOKEN_VECTOR), SECRET)).toBe(true);
    // Missing, empty, guessed, and right-shape-wrong-value all fail.
    expect(isFromProxy(headers(), SECRET)).toBe(false);
    expect(isFromProxy(headers(''), SECRET)).toBe(false);
    expect(isFromProxy(headers('1'), SECRET)).toBe(false);
    expect(isFromProxy(headers('0'.repeat(64)), SECRET)).toBe(false);
    // A token minted from another secret is worthless here.
    expect(isFromProxy(headers(proxyToken('other-secret')), SECRET)).toBe(false);
  });

  it('is not confused by header case', () => {
    // Headers normalizes, but the check must not depend on how it was set.
    expect(isFromProxy(new Headers({ 'X-CMS-Proxy': PROXY_TOKEN_VECTOR }), SECRET)).toBe(true);
  });

  it('answers with the address that does work', async () => {
    const page = proxyRequiredResponse('/chat/abc');
    expect(page.status).toBe(403);
    expect(page.headers.get('Content-Type')).toContain('text/plain');
    const text = await page.text();
    expect(text).toContain('served through its proxy');
    expect(text).toMatch(/https?:\/\//);

    // API callers get the same thing as JSON, so a client can act on it.
    const api = proxyRequiredResponse('/api/chats');
    expect(api.headers.get('Content-Type')).toContain('application/json');
    const body = (await api.json()) as { error: string; entrypoint: string };
    expect(body.entrypoint).toMatch(/^https?:\/\/.+\/$/);
    expect(body.error).toContain(body.entrypoint);
  });
});
