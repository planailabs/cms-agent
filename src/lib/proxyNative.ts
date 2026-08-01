import { createRequire } from 'node:module';
import { prisma } from './db';
import { isEmailAllowed } from './allowlist';

interface NativeProxy {
  startProxy(): void;
  setProxyRoutes(routesJson: string): void;
  setProxySessions(sessions: Array<{ token: string; expiresAtMs: number }>): void;
  upsertProxySession(session: { token: string; expiresAtMs: number }): void;
  proxyAccessTimes(): Array<{ branch: string; atMs: number }>;
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
    state.sessionTimer = setInterval(() => void refreshSessions(), 5_000);
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

export function updateProxySession(session: { token: string; expiresAt: Date }): void {
  if (!state.started) return;
  state.addon?.upsertProxySession({
    token: session.token,
    expiresAtMs: session.expiresAt.getTime(),
  });
}
