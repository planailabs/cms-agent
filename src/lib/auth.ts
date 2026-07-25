/**
 * better-auth configuration — generic OIDC provider via the genericOAuth
 * plugin, Prisma adapter, email allowlist enforced at account creation.
 */
import { createHmac } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { genericOAuth } from 'better-auth/plugins';
import { prisma } from './db';
import { env } from './env';
import { isEmailAllowed } from './allowlist';

const e = env();

export const OIDC_PROVIDER_ID = 'oidc';

export const auth = betterAuth({
  baseURL: e.BETTER_AUTH_URL,
  secret: e.BETTER_AUTH_SECRET,
  advanced:
    e.BASE_DOMAIN === 'localhost'
      ? undefined
      : {
          crossSubDomainCookies: {
            enabled: true,
            domain: e.BASE_DOMAIN,
          },
        },
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'editor', input: false },
      theme: { type: 'string', defaultValue: 'system', input: false },
      language: { type: 'string', defaultValue: 'en', input: false },
      communicationMode: { type: 'string', defaultValue: 'default', input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!isEmailAllowed(user.email)) {
            throw new APIError('FORBIDDEN', {
              message: 'This email address is not authorized for this CMS.',
            });
          }
          return { data: user };
        },
      },
    },
  },
  plugins: [
    genericOAuth({
      config: [
        {
          providerId: OIDC_PROVIDER_ID,
          discoveryUrl: `${e.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
          clientId: e.OIDC_CLIENT_ID,
          clientSecret: e.OIDC_CLIENT_SECRET,
          scopes: ['openid', 'profile', 'email'],
        },
      ],
    }),
  ],
});

export type AuthUser = typeof auth.$Infer.Session.user;
export type AuthSession = typeof auth.$Infer.Session.session;

/** Marker cookie: this browser already carries the domain-wide session cookie. */
export const COOKIE_SCOPE_MARKER = 'cms_cookie_scope';

/**
 * Set-Cookie headers migrating a session cookie to Domain=.BASE_DOMAIN.
 *
 * Sessions created before crossSubDomainCookies was enabled carry a host-only
 * cookie the browser never sends to preview subdomains — the proxy then
 * bounces the preview iframe to /signin/, which redirects signed-in users to
 * the app (the CMS appears inside the preview pane). Re-issue the cookie
 * domain-wide (same value: better-auth signs `<token>.<base64 HMAC-SHA256>`)
 * and expire the host-only variant so it cannot shadow later sign-ins.
 * Returns null when cross-subdomain cookies are off (localhost).
 */
export function sessionCookieMigrationHeaders(token: string, expiresAt: Date): string[] | null {
  if (e.BASE_DOMAIN === 'localhost') return null;
  const secure = e.BETTER_AUTH_URL.startsWith('https');
  const name = secure ? '__Secure-better-auth.session_token' : 'better-auth.session_token';
  const sig = createHmac('sha256', e.BETTER_AUTH_SECRET).update(token).digest('base64');
  const value = encodeURIComponent(`${token}.${sig}`);
  const attrs = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const expires = expiresAt.toUTCString();
  return [
    // host-only cookie (no Domain) — distinct cookie key, expire it first
    `${name}=; ${attrs}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `${name}=${value}; Domain=.${e.BASE_DOMAIN}; ${attrs}; Expires=${expires}`,
    `${COOKIE_SCOPE_MARKER}=1; Domain=.${e.BASE_DOMAIN}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}; Expires=${expires}`,
  ];
}
