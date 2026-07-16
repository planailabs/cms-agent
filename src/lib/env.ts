/**
 * Server-side configuration, validated once at startup.
 * All knobs documented in .env.example and docs/setup.md.
 */
import { z } from 'zod';

const schema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  ALLOWED_EMAILS: z.string().optional(), // comma-separated allowlist
  ALLOWED_EMAIL_DOMAIN: z.string().optional(),

  // Model endpoint (any OpenAI-compatible API)
  OPENAI_BASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  OPENAI_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

  // Domains / networking
  BASE_DOMAIN: z.string().min(1), // e.g. cms.example.com or localhost
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(4321),
  PREVIEW_COOKIE_SECRET: z.string().min(16),

  // Managed target repo
  REPO_PATH: z.string().min(1),
  REPO_DEV_COMMAND: z.string().default('npx astro dev'),
  REPO_BUILD_COMMAND: z.string().default('npx astro build'),
  ROUTE_MAPPINGS: z.string().optional(), // JSON: [{ files: glob, route: pattern }]

  // Deployment
  DEPLOY_FLOW: z.enum(['git-push', 'web-agency', 'github-ci', 'cloudflare-pages']).default('git-push'),
  PUBLISH_COMMAND: z.string().optional(),
  DEPLOY_GIT_REMOTE: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(), // owner/repo
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_PAGES_PROJECT: z.string().optional(),

  // Runtime state
  VAR_DIR: z.string().min(1),

  // Budgets (0 = unlimited)
  INPUT_TOKEN_BUDGET_PER_HOUR: z.coerce.number().int().nonnegative().default(0),
  OUTPUT_TOKEN_BUDGET_PER_HOUR: z.coerce.number().int().nonnegative().default(0),

  // Preview manager
  PREVIEW_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  PREVIEW_MAX_INSTANCES: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test hook — reset the cache after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}
