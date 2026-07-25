import { beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  BETTER_AUTH_URL: 'http://localhost:4321',
  OIDC_ISSUER: 'https://idp.example.com',
  OIDC_CLIENT_ID: 'cms',
  OIDC_CLIENT_SECRET: 'secret',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_MODEL: 'gpt-test',
  BASE_DOMAIN: 'cms.example.com',
  REPO_PATH: '/tmp/repo',
  VAR_DIR: '/tmp/var',
};

async function setEnv(extra: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Dynamic import: always resets the CURRENT registry instance, surviving
  // the vi.resetModules() calls the cookie-migration tests need.
  const { resetEnvCache } = await import('@/lib/env');
  resetEnvCache();
}

beforeEach(() => setEnv({ ALLOWED_EMAILS: undefined, ALLOWED_EMAIL_DOMAIN: undefined }));

describe('sessionCookieMigrationHeaders', () => {
  // @/lib/auth captures env() at module load — reset modules per test.
  it('re-issues the session cookie domain-wide and expires the host-only one', async () => {
    await setEnv({ BETTER_AUTH_URL: 'https://cms.example.com' });
    vi.resetModules();
    const { sessionCookieMigrationHeaders, COOKIE_SCOPE_MARKER } = await import('@/lib/auth');
    const { createHmac } = await import('node:crypto');

    const expires = new Date('2027-01-01T00:00:00Z');
    const headers = sessionCookieMigrationHeaders('tok-123', expires)!;
    expect(headers).toHaveLength(3);

    // 1: host-only cookie expired (no Domain attribute)
    expect(headers[0]).toMatch(/^__Secure-better-auth\.session_token=; /);
    expect(headers[0]).not.toContain('Domain=');
    expect(headers[0]).toContain('Expires=Thu, 01 Jan 1970');

    // 2: domain-wide cookie with better-auth's signed value
    const sig = createHmac('sha256', BASE_ENV.BETTER_AUTH_SECRET).update('tok-123').digest('base64');
    expect(headers[1]).toContain(
      `__Secure-better-auth.session_token=${encodeURIComponent(`tok-123.${sig}`)}`,
    );
    expect(headers[1]).toContain('Domain=.cms.example.com');
    expect(headers[1]).toContain('Secure');
    expect(headers[1]).toContain(`Expires=${expires.toUTCString()}`);

    // 3: marker so the migration runs once per browser
    expect(headers[2]).toContain(`${COOKIE_SCOPE_MARKER}=1`);
  });

  it('uses the unprefixed cookie over http and skips localhost', async () => {
    await setEnv();
    vi.resetModules();
    let mod = await import('@/lib/auth');
    const headers = mod.sessionCookieMigrationHeaders('t', new Date())!;
    expect(headers[1]).toMatch(/^better-auth\.session_token=/);
    expect(headers[1]).not.toContain('Secure');

    await setEnv({ BASE_DOMAIN: 'localhost' });
    vi.resetModules();
    mod = await import('@/lib/auth');
    expect(mod.sessionCookieMigrationHeaders('t', new Date())).toBeNull();
  });
});

describe('isEmailAllowed', () => {
  it('allows everyone when no allowlist is configured', async () => {
    const { isEmailAllowed } = await import('@/lib/allowlist');
    expect(isEmailAllowed('anyone@anywhere.org')).toBe(true);
  });

  it('enforces explicit email list case-insensitively', async () => {
    await setEnv({ ALLOWED_EMAILS: 'Alice@Example.com, bob@example.com' });
    const { isEmailAllowed } = await import('@/lib/allowlist');
    expect(isEmailAllowed('alice@example.com')).toBe(true);
    expect(isEmailAllowed('BOB@EXAMPLE.COM')).toBe(true);
    expect(isEmailAllowed('mallory@example.com')).toBe(false);
  });

  it('enforces domain allowlist', async () => {
    await setEnv({ ALLOWED_EMAIL_DOMAIN: '@example.com' });
    const { isEmailAllowed } = await import('@/lib/allowlist');
    expect(isEmailAllowed('carol@example.com')).toBe(true);
    expect(isEmailAllowed('carol@evil.com')).toBe(false);
  });
});
