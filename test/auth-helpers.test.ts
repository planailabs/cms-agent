import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';

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

function setEnv(extra: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

beforeEach(() => setEnv({ ALLOWED_EMAILS: undefined, ALLOWED_EMAIL_DOMAIN: undefined }));

describe('isEmailAllowed', () => {
  it('allows everyone when no allowlist is configured', async () => {
    const { isEmailAllowed } = await import('@/lib/allowlist');
    expect(isEmailAllowed('anyone@anywhere.org')).toBe(true);
  });

  it('enforces explicit email list case-insensitively', async () => {
    setEnv({ ALLOWED_EMAILS: 'Alice@Example.com, bob@example.com' });
    const { isEmailAllowed } = await import('@/lib/allowlist');
    expect(isEmailAllowed('alice@example.com')).toBe(true);
    expect(isEmailAllowed('BOB@EXAMPLE.COM')).toBe(true);
    expect(isEmailAllowed('mallory@example.com')).toBe(false);
  });

  it('enforces domain allowlist', async () => {
    setEnv({ ALLOWED_EMAIL_DOMAIN: '@example.com' });
    const { isEmailAllowed } = await import('@/lib/allowlist');
    expect(isEmailAllowed('carol@example.com')).toBe(true);
    expect(isEmailAllowed('carol@evil.com')).toBe(false);
  });
});
