/**
 * HMAC-signed cookie shared with the Pingora sidecar so preview hosts
 * (<branch>.BASE_DOMAIN) are only reachable for signed-in editors.
 * Format: <userId>.<expiresAtMs>.<base64url hmac-sha256>
 * The sidecar verifies the same construction with PREVIEW_COOKIE_SECRET.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

export const PREVIEW_COOKIE_NAME = 'cms_preview';
const TTL_MS = 12 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issuePreviewCookie(userId: string): { value: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + TTL_MS);
  const payload = `${userId}.${expiresAt.getTime()}`;
  const value = `${payload}.${sign(payload, env().PREVIEW_COOKIE_SECRET)}`;
  return { value, expiresAt };
}

export function verifyPreviewCookie(value: string): { userId: string } | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(`${userId}.${expStr}`, env().PREVIEW_COOKIE_SECRET);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId };
}

/** Cookie attributes for the Set-Cookie header on the CMS origin. */
export function previewCookieAttributes(expiresAt: Date): string {
  const { BASE_DOMAIN } = env();
  const attrs = [
    `Path=/`,
    `Expires=${expiresAt.toUTCString()}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  // Domain=.localhost is rejected by browsers; host-only cookie still reaches
  // <branch>.localhost in Chromium-based browsers via the sidecar redirect
  // flow — documented in docs/setup.md.
  if (BASE_DOMAIN !== 'localhost') {
    attrs.push(`Domain=.${BASE_DOMAIN}`, 'Secure');
  }
  return attrs.join('; ');
}
