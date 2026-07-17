/**
 * Minimal environment for spawned site processes (dev servers, npm install,
 * site builds). The site repo runs arbitrary — agent-edited — code, so it
 * must NOT inherit the CMS process env (DATABASE_URL, OPENAI_API_KEY,
 * BETTER_AUTH_SECRET, …). Allowlist only what node/npm need to function.
 */
const INHERIT = [
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  'LANG',
  'LC_ALL',
  // TLS trust for npm/fetch in the nix image
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_registry',
] as const;

export function siteChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    FORCE_COLOR: '0',
    ASTRO_TELEMETRY_DISABLED: '1',
    // deliberately NOT NODE_ENV=production: dev servers and installs need dev deps
  };
  for (const key of INHERIT) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
