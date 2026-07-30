/**
 * Build identity — SERVER-ONLY. Do NOT import this from client-executed code.
 *
 * It reads import.meta.env.PUBLIC_GIT_COMMIT, which Vite inlines at build time
 * into every bundle that references it. A client reference would bake the
 * exact commit into the public /_astro/*.js — readable by anonymous callers,
 * which is version-pinning info for targeting known exploits.
 *
 * The commit reaches the client only through the authed SSR page (index.astro
 * sets it as an #app data attribute; anon is redirected to /signin) and the
 * authed GET /api/version. The client reads it back via getAppBuild()
 * (src/components/chat/constants.ts), never from the bundle.
 */
export const APP_VERSION = 'v0.1.1';

/** Short git commit embedded at build time (empty when unknown). */
export const GIT_COMMIT = import.meta.env.PUBLIC_GIT_COMMIT ?? '';
