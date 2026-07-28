/**
 * Preview manager — one dev-server instance per branch worktree (command from
 * the active site backend), spawned on demand, stopped when idle. Publishes
 * the routing table for the Pingora
 * embedded proxy (VAR_DIR/proxy-routes.json) and reads its access timestamps
 * (VAR_DIR/proxy-access.json) to stop idle instances. Plan §5.
 */
import { type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { env } from '@/lib/env';
import { ensureWorktree } from '@/lib/git/engine';
import {
  ensureSandbox,
  runSandboxed,
  spawnSandboxed,
  type SandboxState,
} from '@/lib/sandbox';
import { activeBackend } from '@/lib/site';
import { updateProxyRoutes } from '@/lib/proxyNative';

export interface PreviewInstance {
  branch: string;
  port: number;
  pid: number;
  startedAt: number;
  lastUsedAt: number;
  status: 'starting' | 'ready' | 'stopped';
}

interface ManagerState {
  instances: Map<string, { info: PreviewInstance; child: ChildProcess }>;
  sweeper: ReturnType<typeof setInterval> | null;
  starting: Map<string, Promise<PreviewInstance>>;
  /** Boot-page wait streams notified when preview availability changes. */
  routesListeners: Set<() => void>;
  /** Last failed start per branch, surfaced on the boot page. */
  startErrors: Map<string, { message: string; at: number }>;
  /** Current phase of an in-flight start, streamed to the boot page. */
  startPhases: Map<string, 'deps' | 'server'>;
  /** Branches kept running regardless of idleness (the branches chats fork
   *  from — a cold one would make every new chat wait). */
  pinned: Set<string>;
}

// Survive Vite HMR module reloads in dev
const g = globalThis as unknown as { __previewManager?: ManagerState };
const state: ManagerState =
  g.__previewManager ??
  (g.__previewManager = {
    instances: new Map(),
    sweeper: null,
    starting: new Map(),
    routesListeners: new Set(),
    startErrors: new Map(),
    startPhases: new Map(),
    pinned: new Set(),
  });
state.pinned ??= new Set();
state.startErrors ??= new Map();
state.startPhases ??= new Map();
state.routesListeners ??= new Set();

export function getStartError(branch: string): { message: string; at: number } | null {
  return state.startErrors.get(branch) ?? null;
}

export function getStartPhase(branch: string): 'deps' | 'server' | null {
  return state.startPhases.get(branch) ?? null;
}

export function clearStartError(branch: string): void {
  state.startErrors.delete(branch);
}

export function listStartErrors(): Array<{ branch: string; message: string; at: number }> {
  return [...state.startErrors].map(([branch, e]) => ({ branch, ...e }));
}

const routesFile = () => path.join(path.resolve(env().VAR_DIR), 'proxy-routes.json');
const accessFile = () => path.join(path.resolve(env().VAR_DIR), 'proxy-access.json');

/** host:port for the routes file — IPv6 hosts get brackets. */
function hostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function buildRoutes(): { cms: string; previews: Record<string, string> } {
  const e = env();
  const previews: Record<string, string> = {};
  for (const [branch, { info }] of state.instances) {
    // Preview dev servers bind HOST too (e.g. ::1 in dev) so the proxy — which
    // dials this address — reaches them regardless of the v4/v6 stack.
    if (info.status === 'ready') previews[branch] = hostPort(e.HOST, info.port);
  }
  // cms upstream mirrors HOST (e.g. ::1 in dev, where astro dev binds IPv6)
  return { cms: hostPort(e.HOST, e.PORT), previews };
}

/** Current routing table as single-line JSON for the embedded proxy. */
export function currentRoutesJson(): string {
  return JSON.stringify(buildRoutes());
}

export function subscribeRoutes(listener: () => void): () => void {
  state.routesListeners.add(listener);
  return () => state.routesListeners.delete(listener);
}

function writeRoutesFile(): void {
  const routes = buildRoutes();
  // The file stays as a boot/crash fallback; live state is sent over N-API.
  const payload = JSON.stringify(routes, null, 2);
  fs.mkdirSync(path.dirname(routesFile()), { recursive: true });
  const tmp = routesFile() + '.tmp';
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, routesFile());

  updateProxyRoutes(JSON.stringify(routes));
  for (const listener of state.routesListeners) listener();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // Probe on HOST (the same address the dev server binds) so the port is
    // actually free on that stack (v4/v6).
    srv.listen(0, env().HOST, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Site deps: install when the checkout has none, when package.json changed
 * since the last install (the agent can edit site deps mid-chat), or when
 * `force` is set (boot-page retry = repair).
 */
async function ensureDeps(
  sb: SandboxState,
  worktree: string,
  branch: string,
  force = false,
): Promise<void> {
  const pkgPath = path.join(worktree, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const hash = createHash('sha256').update(fs.readFileSync(pkgPath)).digest('hex');
  const stampPath = path.join(worktree, 'node_modules', '.cms-deps-hash');
  let stamp: string | null = null;
  try {
    stamp = fs.readFileSync(stampPath, 'utf8');
  } catch {
    // no stamp — never installed by us
  }
  if (!force && stamp === hash) return;
  console.log(`[preview] installing site dependencies in ${worktree}…`);
  // --include=dev: dev servers need devDependencies (astro usually lives there)
  const r = await runSandboxed(sb, 'npm install --no-audit --no-fund --include=dev', {
    cwd: worktree,
    sessionKey: branch,
    timeoutMs: 5 * 60_000,
  });
  if (r.code !== 0) {
    throw new Error(`npm install failed (${r.code}): ${(r.stderr || r.stdout).slice(-2000)}`);
  }
  fs.writeFileSync(stampPath, hash);
}

async function waitForHttp(host: string, port: number, timeoutMs = 90_000): Promise<void> {
  const url = `http://${hostPort(host, port)}/`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return; // any HTTP response counts as up
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Preview development environment at ${url} did not come up within ${timeoutMs}ms`);
}

function startSweeper(): void {
  if (state.sweeper) return;
  state.sweeper = setInterval(() => void sweepIdle(), 60_000);
  // Don't keep the process alive just for the sweeper
  if (typeof state.sweeper === 'object' && 'unref' in state.sweeper) state.sweeper.unref();
}

async function sweepIdle(): Promise<void> {
  const { PREVIEW_IDLE_TIMEOUT_MS } = env();
  let access: Record<string, number> = {};
  try {
    access = JSON.parse(fs.readFileSync(accessFile(), 'utf8'));
  } catch {
    // no access file yet — fall back to lastUsedAt below
  }
  const now = Date.now();
  for (const [branch, { info }] of [...state.instances]) {
    if (state.pinned.has(branch)) continue; // pinned branches never idle out
    const lastSeen = Math.max(access[branch] ?? 0, info.lastUsedAt);
    if (info.status === 'ready' && now - lastSeen > PREVIEW_IDLE_TIMEOUT_MS) {
      console.log(`[preview] stopping idle instance ${branch} (idle ${now - lastSeen}ms)`);
      await stopInstance(branch);
    }
  }
}

async function evictForCapacity(): Promise<void> {
  const { PREVIEW_MAX_INSTANCES } = env();
  while (state.instances.size >= PREVIEW_MAX_INSTANCES) {
    let lru: string | null = null;
    let lruTime = Infinity;
    for (const [branch, { info }] of state.instances) {
      if (state.pinned.has(branch)) continue; // pinned ones are the floor
      if (info.lastUsedAt < lruTime) {
        lruTime = info.lastUsedAt;
        lru = branch;
      }
    }
    // Only pinned instances left: run over the cap rather than kill a branch
    // we promised to keep warm.
    if (!lru) break;
    console.log(`[preview] evicting LRU instance ${lru}`);
    await stopInstance(lru);
  }
}

/** True while a start is in flight or a live child is registered — callers
 *  that periodically re-warm must not restart these (killing a slow start
 *  makes it start over, and npm install is not cheap). */
export function isInstanceActive(branch: string): boolean {
  if (state.starting.has(branch)) return true;
  const existing = state.instances.get(branch);
  return !!existing && existing.child.exitCode === null;
}

/** Keep this branch's dev server running (see prewarm.warmPrimaryBranches). */
export function pinBranch(branch: string): void {
  state.pinned.add(branch);
}

/** Stop keeping it warm (branch deleted / renamed). */
export function unpinBranch(branch: string): void {
  state.pinned.delete(branch);
}

export function pinnedBranches(): string[] {
  return [...state.pinned];
}

/**
 * Ensure a dev server runs for the branch; resolves when it accepts HTTP.
 * `repair` forces a dependency re-install (boot-page retry after a failure).
 */
export async function ensureInstance(branch: string, repair = false): Promise<PreviewInstance> {
  // In-flight start first: a second caller must NOT touch the instances
  // entry the in-flight start already registered (deleting it orphaned the
  // child and restarted the branch on every boot-page reload).
  const inFlight = state.starting.get(branch);
  if (inFlight) return inFlight;

  const existing = state.instances.get(branch);
  if (existing && existing.info.status === 'ready' && existing.child.exitCode === null) {
    existing.info.lastUsedAt = Date.now();
    return existing.info;
  }
  if (existing) {
    // crashed or stopped — kill (no-op if already dead) and clean up
    existing.child.kill('SIGTERM');
    state.instances.delete(branch);
    writeRoutesFile();
  }

  const startPromise = (async () => {
    state.startErrors.delete(branch);
    await evictForCapacity();
    const e = env();
    const sb = await ensureSandbox();
    const worktree = await ensureWorktree(branch);
    state.startPhases.set(branch, 'deps');
    await ensureDeps(sb, worktree, branch, repair);
    state.startPhases.set(branch, 'server');
    const port = await freePort();

    // The active site backend builds the full dev-server argv (and may
    // prepare worktree files, e.g. the Astro route-graph config).
    const { argv, extraEnv } = activeBackend().devCommand({
      worktree,
      port,
      host: e.HOST,
      allowedHost: `${branch}.${e.BASE_DOMAIN}`,
    });
    const child = spawnSandboxed(sb, argv, { cwd: worktree, sessionKey: branch, extraEnv });

    const info: PreviewInstance = {
      branch,
      port,
      pid: child.pid ?? -1,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      status: 'starting',
    };
    state.instances.set(branch, { info, child });

    // Rolling tail of the child's output — becomes the error message when
    // the dev server dies before it is ready.
    let logTail = '';
    const appendTail = (d: Buffer) => {
      logTail = (logTail + d.toString()).slice(-4000);
    };
    child.stdout?.on('data', (d: Buffer) => {
      appendTail(d);
      console.log(`[preview:${branch}] ${d.toString().trimEnd()}`);
    });
    child.stderr?.on('data', (d: Buffer) => {
      appendTail(d);
      console.error(`[preview:${branch}] ${d.toString().trimEnd()}`);
    });
    child.on('exit', (code) => {
      console.log(`[preview:${branch}] exited (${code})`);
      const cur = state.instances.get(branch);
      if (cur?.child === child) {
        state.instances.delete(branch);
        writeRoutesFile();
      }
    });

    try {
      // Fail fast (with the captured output) when the dev server exits
      // before accepting HTTP, instead of waiting out the full timeout.
      const earlyExit = new Promise<never>((_, reject) => {
        child.on('exit', (code) => {
          if (info.status === 'starting') {
            reject(
              new Error(
                `development environment exited (${code}) before ready:\n${logTail.slice(-2000)}`,
              ),
            );
          }
        });
      });
      await Promise.race([waitForHttp(e.HOST, port), earlyExit]);
    } catch (err) {
      child.kill('SIGTERM');
      state.instances.delete(branch);
      writeRoutesFile();
      throw err;
    }

    info.status = 'ready';
    writeRoutesFile();
    startSweeper();
    console.log(`[preview] ${branch} ready on port ${port} (worktree ${worktree})`);
    return info;
  })().finally(() => {
    state.starting.delete(branch);
    state.startPhases.delete(branch);
  });

  startPromise.catch((err: unknown) => {
    state.startErrors.set(branch, {
      message: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    });
  });

  state.starting.set(branch, startPromise);
  return startPromise;
}

export async function stopInstance(branch: string): Promise<void> {
  const entry = state.instances.get(branch);
  if (!entry) return;
  state.instances.delete(branch);
  writeRoutesFile();
  entry.info.status = 'stopped';
  entry.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      entry.child.kill('SIGKILL');
      resolve();
    }, 5000);
    entry.child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function listInstances(): PreviewInstance[] {
  return [...state.instances.values()].map((e) => e.info);
}

export async function shutdownAll(): Promise<void> {
  await Promise.all([...state.instances.keys()].map((b) => stopInstance(b)));
  if (state.sweeper) {
    clearInterval(state.sweeper);
    state.sweeper = null;
  }
}

/** Initialize the fallback routes file before the embedded proxy starts. */
export function initRoutesFile(): void {
  try {
    writeRoutesFile();
  } catch (err) {
    console.error('[preview] failed to write routes file:', err);
  }
}
