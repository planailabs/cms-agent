/** Shared internal token: creation, persistence, and Bearer verification. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getInternalToken, verifyInternalRequest } from '@/lib/internalToken';
import { env } from '@/lib/env';

const request = (auth?: string) =>
  new Request('http://localhost/api/internal/proxy-events', {
    headers: auth ? { authorization: auth } : {},
  });

describe('internal token', () => {
  it('creates the token file once and returns a stable value', () => {
    const token = getInternalToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(getInternalToken()).toBe(token);
    const onDisk = fs
      .readFileSync(path.join(path.resolve(env().VAR_DIR), 'internal-token'), 'utf8')
      .trim();
    expect(onDisk).toBe(token);
  });

  it('verifies only the exact bearer token', () => {
    const token = getInternalToken();
    expect(verifyInternalRequest(request(`Bearer ${token}`))).toBe(true);
    expect(verifyInternalRequest(request(`bearer ${token}`))).toBe(true);
    expect(verifyInternalRequest(request())).toBe(false);
    expect(verifyInternalRequest(request('Bearer wrong'))).toBe(false);
    expect(verifyInternalRequest(request(`Bearer ${token}x`))).toBe(false);
    expect(verifyInternalRequest(request(token))).toBe(false);
  });
});
