/**
 * better-auth configuration — generic OIDC provider via the genericOAuth
 * plugin, Prisma adapter, email allowlist enforced at account creation.
 */
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
