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

function sandboxDir(major: string): string {
  const v = (env() as Record<string, string | undefined>)[`SANDBOX_DIR_${major}`];
  if (!v) {
    throw new Error(
      `Sandbox not configured: SANDBOX_DIR_${major} is unset. In the image it is ` +
        `baked in; in dev/test run through scripts/launch-with-sandbox.sh.`,
    );
  }
  return v;
}

function varRoot(): string {
  return path.join(path.resolve(env().VAR_DIR), 'sandbox');
}

/** Mount (squashfuse) or extract (unsquashfs) the env squashfs → storeRoot. */
function materialize(major: string): string {
  const dir = sandboxDir(major);
  const squashfs = fs.realpathSync(path.join(dir, 'env.squashfs'));
  // Content-addressed cache key: the nix store basename of the squashfs.
  const key = path.basename(squashfs).replace(/[^A-Za-z0-9._-]/g, '_');
  const mnt = path.join(varRoot(), 'mnt', `${major}-${key}`);
  const extracted = path.join(varRoot(), 'root', `${major}-${key}`);

  const looksReady = (root: string) =>
    fs.existsSync(root) &&
    fs.readdirSync(root).some((n) => n.endsWith(`-cms-sandbox-env-node${major}`));

  // Already materialized (persisted across restarts on the /data volume).
  if (looksReady(mnt)) return mnt;
  if (looksReady(extracted)) return extracted;

  // Prefer a squashfuse mount (cheap, no disk copy) when /dev/fuse exists.
  if (fs.existsSync('/dev/fuse')) {
    fs.mkdirSync(mnt, { recursive: true });
    const r = spawnSync('squashfuse', [squashfs, mnt], { encoding: 'utf8' });
    if (r.status === 0 && looksReady(mnt)) return mnt;
    // Mount failed (no perms / stale) — clean up and fall through to extract.
    spawnSync('fusermount', ['-u', mnt]);
  }

  // Fallback: extract once (cached by key). unsquashfs needs an empty dest.
  fs.mkdirSync(path.dirname(extracted), { recursive: true });
  if (fs.existsSync(extracted)) fs.rmSync(extracted, { recursive: true, force: true });
  const r = spawnSync('unsquashfs', ['-no-progress', '-dest', extracted, squashfs], {
    encoding: 'utf8',
  });
  if (r.status !== 0 || !looksReady(extracted)) {
    throw new Error(`Sandbox extraction failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
  return extracted;
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
  ];

  if (!env().SANDBOX_ALLOW_NETWORK) args.push('--unshare-net');

  // TLS trust for npm/fetch: bind the real CA bundle to a fixed jail path
  // (its store path is hidden once /nix/store is overshadowed).
  const ca = process.env.SSL_CERT_FILE;
  if (ca && fs.existsSync(ca)) {
    args.push('--ro-bind', ca, '/etc/ssl/certs/ca-bundle.crt');
    args.push('--setenv', 'SSL_CERT_FILE', '/etc/ssl/certs/ca-bundle.crt');
    args.push('--setenv', 'NODE_EXTRA_CA_CERTS', '/etc/ssl/certs/ca-bundle.crt');
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
