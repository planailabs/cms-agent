/**
 * Shared internal token for sidecar↔CMS communication (plan: the proxy
 * authenticates its SSE subscription with it). The CMS creates the token
 * file at boot; the proxy reads the same file from the shared VAR_DIR — no
 * secret ever crosses the network unencrypted beyond localhost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

const tokenPath = () => path.join(path.resolve(env().VAR_DIR), 'internal-token');

let cached: string | null = null;

/** Read the token, creating it (0600) on first use. */
export function getInternalToken(): string {
  if (cached) return cached;
  const p = tokenPath();
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing) return (cached = existing);
  } catch {
    /* create below */
  }
  const token = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${token}\n`, { mode: 0o600 });
  return (cached = token);
}

/** Timing-safe Bearer check for /api/internal/* requests. */
export function verifyInternalRequest(request: Request): boolean {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return false;
  const presented = Buffer.from(match[1]);
  const expected = Buffer.from(getInternalToken());
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
