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
import { isTickerRunning, startTicker, stopTicker } from '@/lib/ticker';
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
  starting: Map<string, Promise<PreviewInstance>>;
  /** Boot-page wait streams, notified when a branch's preview state moves. */
  branchListeners: Set<(branch: string, state: BranchState) => void>;
  /** Last failed start per branch, surfaced on the boot page. */
  startErrors: Map<string, { message: string; at: number }>;
  /** Current phase of an in-flight start, streamed to the boot page. */
  startPhases: Map<string, 'deps' | 'server'>;
  /** Branches kept running regardless of idleness (the branches chats fork
   *  from — a cold one would make every new chat wait). */
  pinned: Set<string>;
  /** Rolling dev-server output per branch (see appendLog). */
  logs: Map<string, string[]>;
}

// Survive Vite HMR module reloads in dev
const g = globalThis as unknown as { __previewManager?: ManagerState };
const state: ManagerState =
  g.__previewManager ??
  (g.__previewManager = {
    instances: new Map(),
    starting: new Map(),
    branchListeners: new Set(),
    startErrors: new Map(),
    startPhases: new Map(),
    pinned: new Set(),
    logs: new Map(),
  });
state.pinned ??= new Set();
state.logs ??= new Map();
state.startErrors ??= new Map();
state.startPhases ??= new Map();
state.branchListeners ??= new Set();

/**
 * Dev-server output is kept in memory per branch, and outlives the process
 * that wrote it: the interesting lines are usually the last ones before a
 * crash, and a stopped instance is exactly when someone goes looking. Bounded
 * per branch, dropped when the branch's worktree is cleaned up.
 */
const MAX_LOG_LINES = 400;

export function appendPreviewLog(branch: string, chunk: string): void {
  const lines = state.logs.get(branch) ?? [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed) lines.push(trimmed);
  }
  state.logs.set(branch, lines.slice(-MAX_LOG_LINES));
}

/** Tail of a branch's dev-server output, oldest first ([] when none). */
export function previewLogs(branch: string, lines = 100): string[] {
  const all = state.logs.get(branch) ?? [];
  return all.slice(-Math.max(1, lines));
}

export function clearPreviewLogs(branch: string): void {
  state.logs.delete(branch);
}

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

/**
 * Where a preview actually listens. Dev servers bind HOST, which is ::1 in
 * development and 127.0.0.1 in production — anything that assumes one of them
 * works on one machine and is refused on the other, with undici reporting it
 * as an opaque "fetch failed". Every caller uses this.
 */
export const previewOrigin = (port: number): string => `http://${hostPort(env().HOST, port)}`;

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

/**
 * Where a branch's preview is, as far as anyone waiting for it cares.
 * 'gone' covers stopped, evicted and crashed — from a waiting browser they
 * are the same fact: nothing is serving this branch right now.
 */
export type BranchState = 'deps' | 'server' | 'ready' | 'failed' | 'gone';

/**
 * Subscribe to preview state changes for every branch.
 *
 * The manager knows the moment a start moves; a waiting browser used to
 * discover it by re-reading this module's maps every 500 ms, once per client.
 * That is work proportional to how many people are waiting, to learn
 * something one place already knew.
 */
export function subscribeBranchState(
  listener: (branch: string, state: BranchState) => void,
): () => void {
  state.branchListeners.add(listener);
  return () => state.branchListeners.delete(listener);
}

function notifyBranch(branch: string, next: BranchState): void {
  for (const listener of state.branchListeners) {
    try {
      listener(branch, next);
    } catch (err) {
      // A broken listener must not take the start path down with it.
      console.error('[preview] branch-state listener failed:', err);
    }
  }
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
 * Serializes every npm install this process runs (see ensureDeps): warming a
 * branch, priming a spare and creating a chat can all want one at the same
 * time, and parallel installs only starve each other — one of them ends up
 * killed on the 5-minute timeout.
 */
// On globalThis with the rest of the manager state: two copies of this module
// mean two queues, and two parallel `npm install` runs in the same worktree
// starve each other into the timeout — which is the whole point of a queue.
const installState = ((globalThis as unknown as { __previewInstallQueue?: { p: Promise<unknown> } })
  .__previewInstallQueue ??= { p: Promise.resolve() });

export function queueInstall<T>(run: () => Promise<T>): Promise<T> {
  const next = installState.p.catch(() => {}).then(run);
  installState.p = next.catch(() => {}); // one failure must not break the queue
  return next;
}

function readDepsStamp(stampPath: string): string | null {
  try {
    return fs.readFileSync(stampPath, 'utf8');
  } catch {
    return null;
  }
}

/** Lockfile → the command that owns it. First match wins, npm last (its
 *  lockfile is the one most likely to be present alongside another). */
const PACKAGE_MANAGERS: Array<{ lockfile: string; install: string }> = [
  { lockfile: 'pnpm-lock.yaml', install: 'pnpm install --prod=false' },
  { lockfile: 'yarn.lock', install: 'yarn install --production=false' },
  { lockfile: 'bun.lockb', install: 'bun install' },
  // --include=dev: dev servers need devDependencies (astro usually lives there)
  { lockfile: 'package-lock.json', install: 'npm install --no-audit --no-fund --include=dev' },
];

/**
 * Which installer this checkout expects, and the lockfile that decides it.
 * Running `npm install` in a pnpm repo rewrites the tree its lockfile
 * describes and can install versions the site was never tested with.
 */
export function packageManagerFor(worktree: string): { lockfile: string | null; install: string } {
  for (const pm of PACKAGE_MANAGERS) {
    if (fs.existsSync(path.join(worktree, pm.lockfile))) return pm;
  }
  return { lockfile: null, install: PACKAGE_MANAGERS[PACKAGE_MANAGERS.length - 1].install };
}

/** Does node_modules still look like something an install produced? Executables
 *  are what the dev command reaches for, so an empty .bin is not "installed". */
function hasInstalledBinaries(worktree: string): boolean {
  try {
    return fs.readdirSync(path.join(worktree, 'node_modules', '.bin')).length > 0;
  } catch {
    return false;
  }
}

/** Fingerprint of what an install would produce: the manifest and the lockfile
 *  that pins it. package.json alone misses `npm install` writing a new lock. */
export function depsFingerprint(worktree: string, lockfile: string | null): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(path.join(worktree, 'package.json')));
  if (lockfile) {
    try {
      hash.update(fs.readFileSync(path.join(worktree, lockfile)));
    } catch {
      // Deleted between the check and here — a missing lock is its own state.
      hash.update('no-lockfile');
    }
  }
  return hash.digest('hex');
}

/**
 * Site deps: install when the checkout has none, when the manifest or the
 * lockfile changed since the last install (the agent can edit site deps
 * mid-chat), or when `force` is set (boot-page retry = repair).
 */
/**
 * The expensive half of warming a branch — checkout plus install — without
 * starting a dev server for it.
 *
 * A spare branch nobody has claimed yet does not need a running server: it
 * would hold a port, memory and one of PREVIEW_MAX_INSTANCES slots until a
 * chat adopts it, and the first thing a claim does is start one anyway. The
 * install is what takes minutes and what survives into the adopted worktree.
 */
export async function prepareWorktreeDeps(branch: string): Promise<void> {
  const sb = await ensureSandbox();
  const worktree = await ensureWorktree(branch);
  await ensureDeps(sb, worktree, branch);
}

async function ensureDeps(
  sb: SandboxState,
  worktree: string,
  branch: string,
  force = false,
): Promise<void> {
  if (!fs.existsSync(path.join(worktree, 'package.json'))) return;
  const { lockfile, install } = packageManagerFor(worktree);
  const hash = depsFingerprint(worktree, lockfile);
  const stampPath = path.join(worktree, 'node_modules', '.cms-deps-hash');
  const stamp = readDepsStamp(stampPath); // null = never installed by us
  // The stamp says what WAS installed; it cannot say the tree survived. A
  // half-deleted node_modules still carries it, and the next boot then skips
  // the install and dies on "Cannot find module" from the dev server instead —
  // a failure that reads like a broken site and is not one.
  if (!force && stamp === hash && hasInstalledBinaries(worktree)) return;
  await queueInstall(async () => {
    // The queue may have been long — another install for this worktree could
    // have finished it meanwhile.
    if (!force && readDepsStamp(stampPath) === hash && hasInstalledBinaries(worktree)) return;
    console.log(`[preview] installing site dependencies in ${worktree} (${install})…`);
    const r = await runSandboxed(sb, install, {
      cwd: worktree,
      sessionKey: branch,
      timeoutMs: 5 * 60_000,
    });
    if (r.code !== 0) {
      throw new Error(`${install} failed (${r.code}): ${(r.stderr || r.stdout).slice(-2000)}`);
    }
    // Fingerprint the tree the installer LEFT: it may have written or updated
    // the lockfile itself, and stamping the pre-install hash would make the
    // next boot reinstall every time.
    fs.writeFileSync(stampPath, depsFingerprint(worktree, lockfile));
  });
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

/** One named ticker for idle sweeping: it skips overlapping passes, survives
 *  a dev reload by name instead of by module-level state, and is visible to
 *  whoever asks which background loops are running (lib/ticker.ts). */
const SWEEPER = 'preview-sweeper';

function startSweeper(): void {
  if (isTickerRunning(SWEEPER)) return;
  startTicker(SWEEPER, 60_000, sweepIdle);
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
    notifyBranch(branch, 'gone');
  }

  const startPromise = (async () => {
    state.startErrors.delete(branch);
    await evictForCapacity();
    const e = env();
    const sb = await ensureSandbox();
    const worktree = await ensureWorktree(branch);
    state.startPhases.set(branch, 'deps');
    notifyBranch(branch, 'deps');
    await ensureDeps(sb, worktree, branch, repair);
    state.startPhases.set(branch, 'server');
    notifyBranch(branch, 'server');
    const port = await freePort();

    // The active site backend builds the full dev-server argv (and may
    // prepare worktree files, e.g. the Astro route-graph config).
    const { argv, extraEnv } = activeBackend().devCommand({
      worktree,
      port,
      host: e.HOST,
      allowedHost: `${branch}.${e.BASE_DOMAIN}`,
    });
    appendPreviewLog(branch, `── starting: ${argv.join(' ')} ──`);
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
      appendPreviewLog(branch, d.toString());
      console.log(`[preview:${branch}] ${d.toString().trimEnd()}`);
    });
    child.stderr?.on('data', (d: Buffer) => {
      appendTail(d);
      appendPreviewLog(branch, d.toString());
      console.error(`[preview:${branch}] ${d.toString().trimEnd()}`);
    });
    child.on('exit', (code) => {
      appendPreviewLog(branch, `── development server exited (${code}) ──`);
      console.log(`[preview:${branch}] exited (${code})`);
      const cur = state.instances.get(branch);
      if (cur?.child === child) {
        state.instances.delete(branch);
        writeRoutesFile();
        notifyBranch(branch, 'gone');
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
      // 'failed' follows once the error is recorded below — this is the
      // instance disappearing, which a waiter may already act on.
      notifyBranch(branch, 'gone');
      throw err;
    }

    info.status = 'ready';
    writeRoutesFile();
    notifyBranch(branch, 'ready');
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
    // Recorded, so the boot page can render it — tell the waiters now.
    notifyBranch(branch, 'failed');
  });

  state.starting.set(branch, startPromise);
  return startPromise;
}

export async function stopInstance(branch: string): Promise<void> {
  const entry = state.instances.get(branch);
  if (!entry) return;
  state.instances.delete(branch);
  writeRoutesFile();
  notifyBranch(branch, 'gone');
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
  stopTicker(SWEEPER);
}

/** Initialize the fallback routes file before the embedded proxy starts. */
export function initRoutesFile(): void {
  try {
    writeRoutesFile();
  } catch (err) {
    console.error('[preview] failed to write routes file:', err);
  }
}
