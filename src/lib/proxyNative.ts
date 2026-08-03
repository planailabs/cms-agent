import { createRequire } from 'node:module';
import { prisma } from './db';
import { isEmailAllowed } from './allowlist';

interface NativeProxy {
  startProxy(): void;
  setProxyRoutes(routesJson: string): void;
  setProxySessions(sessions: Array<{ token: string; expiresAtMs: number }>): void;
  upsertProxySession(session: { token: string; expiresAtMs: number }): void;
  dropProxySession(token: string): void;
  proxyAccessTimes(): Array<{ branch: string; atMs: number }>;
  proxyMetricsText(): string;
}

interface NativeProxyState {
  addon: NativeProxy | null;
  started: boolean;
  sessionTimer: ReturnType<typeof setInterval> | null;
}

const g = globalThis as typeof globalThis & { __nativeProxy?: NativeProxyState };
const state =
  g.__nativeProxy ??
  (g.__nativeProxy = {
    addon: null,
    started: false,
    sessionTimer: null,
  });

function addon(): NativeProxy {
  if (state.addon) return state.addon;
  const nativePath = process.env.PROXY_NATIVE_PATH;
  if (!nativePath) throw new Error('PROXY_NATIVE_PATH is required');
  state.addon = createRequire(import.meta.url)(nativePath) as NativeProxy;
  return state.addon;
}

/**
 * Full session reconciliation interval.
 *
 * This used to run every 5 seconds because it was the ONLY thing that ever
 * removed a session from the proxy — the revocation delay was the interval.
 * Now sign-out revokes directly (revokeProxySession) and the proxy enforces
 * expiry itself against each token's own deadline, so this tick covers only
 * what neither can see:
 *
 *   - a session row deleted out of band (psql, another process)
 *   - Better Auth's multi-session revoke endpoints, whose tokens are in a
 *     request body this layer does not parse
 *   - an allowlist change (env — a restart reconciles anyway)
 *
 * Those are rare and administrative, so a slower sweep is the right trade:
 * their worst-case delay is this interval. Sign-out is not in the list and
 * must never end up back in it.
 */
const SESSION_RECONCILE_MS = 30_000;

async function refreshSessions(): Promise<void> {
  if (!state.started || !state.addon) return;
  try {
    const sessions = await prisma.session.findMany({
      where: { expiresAt: { gt: new Date() } },
      select: { token: true, expiresAt: true, user: { select: { email: true } } },
    });
    state.addon.setProxySessions(
      sessions
        .filter((session) => isEmailAllowed(session.user.email))
        .map((session) => ({
          token: session.token,
          expiresAtMs: session.expiresAt.getTime(),
        })),
    );
  } catch (error) {
    console.error('[proxy] failed to refresh active sessions:', error);
  }
}

export function startEmbeddedProxy(initialRoutesJson: string): void {
  const native = addon();
  if (!state.started) {
    native.startProxy();
    state.started = true;
  }
  native.setProxyRoutes(initialRoutesJson);
  if (!state.sessionTimer) {
    void refreshSessions();
    state.sessionTimer = setInterval(() => void refreshSessions(), SESSION_RECONCILE_MS);
    state.sessionTimer.unref();
  }
}

export function updateProxyRoutes(routesJson: string): void {
  if (state.started) state.addon?.setProxyRoutes(routesJson);
}

/**
 * Last-access time per preview branch, straight from the proxy's own map.
 *
 * The idle sweep used to read a JSON file the proxy flushed every ten
 * seconds — a writer thread, a dirty flag and an atomic rename to move state
 * between two halves of the SAME process. Empty when the proxy is not
 * running, which the sweeper already handles by falling back to lastUsedAt.
 */
/**
 * Revoke a session in the proxy immediately.
 *
 * The reconciliation tick below would drop it on its next pass, but that is
 * the wrong contract for a sign-out: until then the cookie still opens
 * previews. With this, the tick is a backstop for what it cannot see (a row
 * deleted by another process, an expiry) rather than the only revocation
 * mechanism — which is what let it be slowed down.
 */
export function revokeProxySession(token: string): void {
  if (!state.started) return;
  try {
    state.addon?.dropProxySession(token);
  } catch (err) {
    // The next reconcile still catches it; a failed revoke must not fail the
    // sign-out the user asked for.
    console.warn('[proxy] could not revoke a session:', err);
  }
}

export function proxyAccessTimes(): Record<string, number> {
  if (!state.started) return {};
  try {
    const entries = state.addon?.proxyAccessTimes() ?? [];
    return Object.fromEntries(entries.map((e) => [e.branch, e.atMs]));
  } catch (err) {
    // A sweep must not die because the proxy is mid-restart.
    console.warn('[proxy] could not read access times:', err);
    return {};
  }
}

/**
 * The proxy's Prometheus exposition, appended to the CMS's own by
 * lib/metrics. Empty when the proxy is not running — the endpoint still
 * serves the half that is.
 */
export function proxyMetricsText(): string {
  if (!state.started) return '';
  try {
    return state.addon?.proxyMetricsText() ?? '';
  } catch (err) {
    console.warn('[proxy] could not read metrics:', err);
    return '';
  }
}

export function updateProxySession(session: { token: string; expiresAt: Date }): void {
  if (!state.started) return;
  state.addon?.upsertProxySession({
    token: session.token,
    expiresAtMs: session.expiresAt.getTime(),
  });
}
