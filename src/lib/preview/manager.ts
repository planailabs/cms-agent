/**
 * Preview manager — one `astro dev` instance per branch worktree, spawned on
 * demand, stopped when idle. Publishes the routing table for the Pingora
 * sidecar (VAR_DIR/proxy-routes.json) and reads its access timestamps
 * (VAR_DIR/proxy-access.json) to stop idle instances. Plan §5.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { env } from '@/lib/env';
import { ensureWorktree } from '@/lib/git/engine';

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
}

// Survive Vite HMR module reloads in dev
const g = globalThis as unknown as { __previewManager?: ManagerState };
const state: ManagerState =
  g.__previewManager ?? (g.__previewManager = { instances: new Map(), sweeper: null, starting: new Map() });

const routesFile = () => path.join(path.resolve(env().VAR_DIR), 'proxy-routes.json');
const accessFile = () => path.join(path.resolve(env().VAR_DIR), 'proxy-access.json');

/** host:port for the routes file — IPv6 hosts get brackets. */
function hostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function writeRoutesFile(): void {
  const e = env();
  const previews: Record<string, string> = {};
  for (const [branch, { info }] of state.instances) {
    if (info.status === 'ready') previews[branch] = `127.0.0.1:${info.port}`;
  }
  // cms upstream mirrors HOST (e.g. ::1 in dev, where astro dev binds IPv6)
  const payload = JSON.stringify({ cms: hostPort(e.HOST, e.PORT), previews }, null, 2);
  fs.mkdirSync(path.dirname(routesFile()), { recursive: true });
  const tmp = routesFile() + '.tmp';
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, routesFile());
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHttp(port: number, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return; // any HTTP response counts as up
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Preview dev server on port ${port} did not come up within ${timeoutMs}ms`);
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
      if (info.lastUsedAt < lruTime) {
        lruTime = info.lastUsedAt;
        lru = branch;
      }
    }
    if (!lru) break;
    console.log(`[preview] evicting LRU instance ${lru}`);
    await stopInstance(lru);
  }
}

/** Ensure a dev server runs for the branch; resolves when it accepts HTTP. */
export async function ensureInstance(branch: string): Promise<PreviewInstance> {
  const existing = state.instances.get(branch);
  if (existing && existing.info.status === 'ready' && existing.child.exitCode === null) {
    existing.info.lastUsedAt = Date.now();
    return existing.info;
  }
  if (existing) {
    // crashed or stopped — clean up before restart
    state.instances.delete(branch);
    writeRoutesFile();
  }

  const inFlight = state.starting.get(branch);
  if (inFlight) return inFlight;

  const startPromise = (async () => {
    await evictForCapacity();
    const e = env();
    const worktree = await ensureWorktree(branch);
    const port = await freePort();

    // REPO_DEV_COMMAND is split on whitespace (document: no shell quoting)
    const [cmd, ...args] = e.REPO_DEV_COMMAND.split(/\s+/);
    const child = spawn(cmd, [...args, '--port', String(port), '--host', '127.0.0.1'], {
      cwd: worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    const info: PreviewInstance = {
      branch,
      port,
      pid: child.pid ?? -1,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      status: 'starting',
    };
    state.instances.set(branch, { info, child });

    child.stdout?.on('data', (d: Buffer) =>
      console.log(`[preview:${branch}] ${d.toString().trimEnd()}`),
    );
    child.stderr?.on('data', (d: Buffer) =>
      console.error(`[preview:${branch}] ${d.toString().trimEnd()}`),
    );
    child.on('exit', (code) => {
      console.log(`[preview:${branch}] exited (${code})`);
      const cur = state.instances.get(branch);
      if (cur?.child === child) {
        state.instances.delete(branch);
        writeRoutesFile();
      }
    });

    try {
      await waitForHttp(port);
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
  })().finally(() => state.starting.delete(branch));

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

/** Initialize the routes file at boot so the sidecar can route the CMS host. */
export function initRoutesFile(): void {
  try {
    writeRoutesFile();
  } catch (err) {
    console.error('[preview] failed to write routes file:', err);
  }
}
