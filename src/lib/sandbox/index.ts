/**
 * Bubblewrap sandbox for ALL site shell calls (npm install, the preview dev
 * server, publish builds, and the run_command tool).
 *
 * The jail is deny-by-default: bwrap starts with an empty root and only the
 * allowlisted paths are bound in — the per-major node/coreutils/bash env's
 * store (over /nix/store, fully overshadowing the app's store), the chat's
 * worktree (/work), and a per-session HOME (/home/sandbox). Nothing else of
 * the host is visible.
 *
 * The env ships as a squashfs (built by nix). We prefer a squashfuse mount
 * and fall back to extracting it into VAR_DIR when /dev/fuse is unavailable
 * (unprivileged docker). Requires the container to run under the targeted
 * seccomp profile (deploy/seccomp/cms-agent.json) so bwrap can create the
 * user+mount namespaces.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';

export interface SandboxState {
  major: string;
  /** Host dir whose contents are the sandbox /nix/store (bound over it). */
  storeRoot: string;
  /** In-jail absolute path of the env root (…/bin has node, npm, bash, env). */
  envRootInJail: string;
  /** Host path of the env root (for --ro-bind sources). */
  envRootHost: string;
}

const MAX_OUTPUT_CHARS = 50_000;

const state = new Map<string, Promise<SandboxState>>();

function sandboxDir(): string {
  const v = env().SANDBOX_DIR;
  if (!v) {
    throw new Error(
      `Sandbox not configured: SANDBOX_DIR is unset. In the image it is baked ` +
        `in; in dev/test run through scripts/launch-with-sandbox.sh.`,
    );
  }
  return v;
}

function varRoot(): string {
  return path.join(path.resolve(env().VAR_DIR), 'sandbox');
}

/**
 * Make the selected major's /nix/store available and return its path. The
 * combined squashfs holds one self-contained store per major (node22/ etc.);
 * we mount the whole image (squashfuse) or extract ONLY the major's folder
 * (unsquashfs <folder>), so runtime disk stays at one major's closure.
 */
function materialize(major: string): string {
  const squashfs = fs.realpathSync(path.join(sandboxDir(), 'sandbox.squashfs'));
  // Content-addressed cache key: the nix store basename of the squashfs.
  const key = path.basename(squashfs).replace(/[^A-Za-z0-9._-]/g, '_');
  const folder = `node${major}`;
  const mnt = path.join(varRoot(), 'mnt', key);
  const mntStore = path.join(mnt, folder, 'nix', 'store');
  const dest = path.join(varRoot(), 'root', `${key}-${folder}`);
  const destStore = path.join(dest, folder, 'nix', 'store');

  const looksReady = (store: string) =>
    fs.existsSync(store) &&
    fs.readdirSync(store).some((n) => n.endsWith(`-cms-sandbox-env-node${major}`));

  // Already materialized (persisted across restarts on the /data volume).
  if (looksReady(mntStore)) return mntStore;
  if (looksReady(destStore)) return destStore;

  // Prefer a squashfuse mount of the whole image (cheap) when /dev/fuse exists.
  if (fs.existsSync('/dev/fuse')) {
    fs.mkdirSync(mnt, { recursive: true });
    const r = spawnSync('squashfuse', [squashfs, mnt], { encoding: 'utf8' });
    if (r.status === 0 && looksReady(mntStore)) return mntStore;
    spawnSync('fusermount', ['-u', mnt]);
  }

  // Fallback: extract ONLY this major's folder (self-contained store).
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  const r = spawnSync('unsquashfs', ['-no-progress', '-dest', dest, squashfs, folder], {
    encoding: 'utf8',
  });
  if (r.status !== 0 || !looksReady(destStore)) {
    throw new Error(`Sandbox extraction failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
  return destStore;
}

/**
 * A minimal /etc for the jail — just a resolver config so `npm install` can
 * resolve DNS. Written once under VAR_DIR (never the host's /etc, which would
 * leak secrets). glibc's built-in `dns` module lives in the sandbox store.
 */
function sandboxEtc(): string {
  const etc = path.join(varRoot(), 'etc');
  fs.mkdirSync(etc, { recursive: true });
  const nss = path.join(etc, 'nsswitch.conf');
  if (!fs.existsSync(nss)) fs.writeFileSync(nss, 'passwd: files\ngroup: files\nhosts: files dns\n');
  return etc;
}

/** Build the bwrap argv prefix (everything up to the command). */
function bwrapArgs(sb: SandboxState, opts: SandboxRunOptions): string[] {
  const worktree = fs.realpathSync(opts.cwd);
  const home = path.join(varRoot(), 'home', opts.sessionKey ?? 'default');
  fs.mkdirSync(home, { recursive: true });

  const args = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    // /nix/store = the sandbox env's store ONLY (overshadows the app store)
    '--ro-bind', sb.storeRoot, '/nix/store',
    // shells / env resolver for shebangs + npm lifecycle scripts
    '--ro-bind', path.join(sb.envRootHost, 'bin/bash'), '/bin/sh',
    '--ro-bind', path.join(sb.envRootHost, 'bin/env'), '/usr/bin/env',
    // the only writable host location: the chat's worktree
    '--bind', worktree, '/work',
    '--bind', home, '/home/sandbox',
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--chdir', '/work',
    '--setenv', 'PATH', `/work/node_modules/.bin:${sb.envRootInJail}/bin`,
    '--setenv', 'HOME', '/home/sandbox',
    '--setenv', 'NODE_ENV', opts.nodeEnv ?? 'development',
    // TLS trust from the sandbox's own cacert (store is overshadowed)
    '--setenv', 'SSL_CERT_FILE', `${sb.envRootInJail}/etc/ssl/certs/ca-bundle.crt`,
    '--setenv', 'NODE_EXTRA_CA_CERTS', `${sb.envRootInJail}/etc/ssl/certs/ca-bundle.crt`,
  ];

  if (env().SANDBOX_ALLOW_NETWORK) {
    // DNS resolution needs a resolver config + hosts (bound read-only from the
    // host; nsswitch is our minimal one so no host NSS modules are required).
    args.push('--ro-bind', path.join(sandboxEtc(), 'nsswitch.conf'), '/etc/nsswitch.conf');
    args.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf');
    args.push('--ro-bind-try', '/etc/hosts', '/etc/hosts');
  } else {
    args.push('--unshare-net');
  }

  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
    args.push('--setenv', k, v);
  }
  return args;
}

export interface SandboxRunOptions {
  /** Host worktree bound to /work. */
  cwd: string;
  /** Per-session HOME bucket (chatId/branch) — isolates npm cache/config. */
  sessionKey?: string;
  extraEnv?: Record<string, string>;
  nodeEnv?: 'development' | 'production';
}

/** Ensure the sandbox for a node major is usable. Required — throws on failure. */
export function ensureSandbox(major = env().SANDBOX_NODE_MAJOR): Promise<SandboxState> {
  const cached = state.get(major);
  if (cached) return cached;

  const p = (async (): Promise<SandboxState> => {
    if (spawnSync('bwrap', ['--version']).status !== 0) {
      throw new Error('bubblewrap (bwrap) not found — the sandbox is required.');
    }
    const storeRoot = materialize(major);
    const envName = fs
      .readdirSync(storeRoot)
      .find((n) => n.endsWith(`-cms-sandbox-env-node${major}`));
    if (!envName) throw new Error(`Sandbox env for node ${major} missing in ${storeRoot}`);
    const sb: SandboxState = {
      major,
      storeRoot,
      envRootHost: path.join(storeRoot, envName),
      envRootInJail: `/nix/store/${envName}`,
    };
    // Probe: a real run confirms bwrap can create the namespaces here (fails
    // fast with a clear message when seccomp blocks unshare(CLONE_NEWUSER)).
    const probe = spawnSync('bwrap', [...bwrapArgs(sb, { cwd: process.cwd() }), '/bin/sh', '-c', 'node --version'], {
      encoding: 'utf8',
    });
    if (probe.status !== 0 || !/^v\d+/.test(probe.stdout.trim())) {
      throw new Error(
        `Sandbox probe failed (is the container running under the targeted seccomp ` +
          `profile?): ${probe.stderr || probe.stdout || `exit ${probe.status}`}`,
      );
    }
    console.log(`[sandbox] node ${major} ready (store ${storeRoot})`);
    return sb;
  })();

  state.set(major, p);
  p.catch(() => state.delete(major)); // allow retry after a transient failure
  return p;
}

/**
 * Full argv for running `command` in the jail — for callers that spawn the
 * process themselves (e.g. an MCP stdio transport). The command must exist
 * in the sandbox env (its bin/ is on the jail PATH).
 */
export function sandboxCommand(
  sb: SandboxState,
  command: string[],
  opts: SandboxRunOptions,
): { command: string; args: string[] } {
  return { command: 'bwrap', args: [...bwrapArgs(sb, opts), ...command] };
}

/** True when `bin` exists in the sandbox env (host-side check). */
export function sandboxHasBin(sb: SandboxState, bin: string): boolean {
  return fs.existsSync(path.join(sb.envRootHost, 'bin', bin));
}

/** Spawn a long-lived sandboxed process (e.g. the preview dev server). */
export function spawnSandboxed(
  sb: SandboxState,
  command: string[],
  opts: SandboxRunOptions,
): ChildProcess {
  return spawn('bwrap', [...bwrapArgs(sb, opts), ...command], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface SandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a one-shot shell command in the sandbox; capture output with a cap. */
export function runSandboxed(
  sb: SandboxState,
  command: string,
  opts: SandboxRunOptions & { timeoutMs?: number },
): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bwrap', [...bwrapArgs(sb, opts), '/bin/sh', '-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, add: string) =>
      s.length >= MAX_OUTPUT_CHARS ? s : (s + add).slice(0, MAX_OUTPUT_CHARS);
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d.toString())));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d.toString())));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
