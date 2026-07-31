/**
 * Server-side configuration, validated once at startup.
 * All knobs documented in .env.example and docs/setup.md
 * (served at /architecture/setup).
 *
 * dotenv/config: Vite only exposes .env via import.meta.env — we read
 * process.env (shared with non-Vite code paths like server.mjs), so load
 * .env ourselves. Existing process vars win; absent file is a no-op.
 */
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  // Development only: no sign-in; every request runs as admin@localhost
  // (seeded together with user@localhost/user2@localhost for impersonation).
  SKIP_AUTH: z
    .preprocess((v) => v === 'true' || v === '1', z.boolean())
    .default(false),

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
  OPENAI_IMAGE_MODEL: z.string().min(1).default('gpt-image-1'),
  // Vision-capable model for turns whose context contains an image attachment;
  // falls back to OPENAI_MODEL when unset.
  OPENAI_VISION_MODEL: z.string().min(1).optional(),
  // Smaller model the testbench judge grades results with; call sites fall
  // back to OPENAI_MODEL when unset.
  JUDGE_MODEL: z.string().min(1).optional(),
  // Small model that picks the skills and MCP groups a turn is hinted with
  // (lib/agent/skillRouter). Required: without routing every prompt would
  // carry every skill again, which is the cost this exists to remove — a
  // silent fallback would hide a broken router forever.
  SKILL_ROUTER_MODEL: z.string().min(1),
  OPENAI_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  // Reasoning effort forwarded to chat completions (reasoning models).
  // 'none' omits the parameter for backends that reject it.
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'none']).default('medium'),
  DEFAULT_COMMUNICATION_MODE: z.enum(['technical', 'non-technical']).default('non-technical'),

  // Domains / networking
  BASE_DOMAIN: z.string().min(1), // e.g. cms.example.com or localhost
  // Scheme browsers reach the CMS with. Behind TLS-terminating proxies the
  // node server only sees http, so this can't be derived from the request.
  PUBLIC_SCHEME: z.enum(['http', 'https']).optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(4321),
  FIRECRAWL_NATIVE_PATH: z.string().optional(),
  PROXY_NATIVE_PATH: z.string().optional(),

  // Managed target repo
  REPO_PATH: z.string().min(1),
  // Site backend id ('astro' | 'static'); auto-detected from the repo when
  // unset. Validated against the registry in activeBackend(), not here.
  SITE_BACKEND: z.string().optional(),
  // Dev/build command overrides; defaults come from the active site backend.
  REPO_DEV_COMMAND: z.string().optional(),
  REPO_BUILD_COMMAND: z.string().optional(),
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

  // Sandbox (bubblewrap jail for ALL site shell calls — install, dev server,
  // build, run_command). Requires the container to run with the targeted
  // seccomp profile (deploy/seccomp/cms-agent.json).
  // 'none' (dev only, default on macOS where bwrap does not exist): no jail —
  // site commands run with the PATH of the matching `nix develop
  // .#sandbox-node<major>` shell and a scrubbed environment instead.
  SANDBOX_MODE: z
    .enum(['bwrap', 'none'])
    .default(process.platform === 'darwin' ? 'none' : 'bwrap'),
  SANDBOX_NODE_MAJOR: z.enum(['22', '24', '26']).default('26'),
  // Keep network in the jail (needed for `npm install`); set 0 to isolate.
  SANDBOX_ALLOW_NETWORK: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
  // Path to the built sandbox dir (sandbox.squashfs + manifest). The squashfs
  // holds one self-contained store per major (node22/ node24/ node26/); the
  // runtime materializes the folder for SANDBOX_NODE_MAJOR. Baked into the
  // image; set by launch-with-sandbox.sh in dev/test.
  SANDBOX_DIR: z.string().optional(),
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
