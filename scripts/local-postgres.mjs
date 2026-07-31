/**
 * Repository-declared PostgreSQL lifecycle — the "project" database mode of
 * the start skill (.agents/skills/start/SKILL.md).
 *
 * Runs a cluster the repository owns: initialised under var/postgres (gitignored)
 * with the credentials from DATABASE_URL, listening only on the loopback host and
 * port that URL names. Nothing outside the repo is created, started, or stopped —
 * a foreign server already holding the port is reported, never adopted.
 *
 * Usage — inside the dev shell, which provides initdb/pg_ctl/psql:
 *   nix develop --command pnpm run db:start | db:stop | db:status
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as dotenvParse } from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'var', 'postgres');
const LOG_FILE = path.join(ROOT, 'var', 'postgres.log');

// Loopback only. A project-mode cluster is a development convenience; pointing
// it at anything reachable from outside this machine is a mistake, not a config.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Everything the lifecycle needs, derived from DATABASE_URL. */
export function clusterConfig(databaseUrl, dataDir = DATA_DIR) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL is not a PostgreSQL URL (${url.protocol}//…)`);
  }
  // ?host=/path selects a unix socket; then the URL's own host is ignored.
  const socketOverride = url.searchParams.get('host');
  const host = socketOverride ? null : url.hostname || '127.0.0.1';
  if (host && !LOCAL_HOSTS.has(host)) {
    throw new Error(
      `DATABASE_URL points at ${host} — project mode only manages a cluster on this machine. ` +
        'Use the docker or system database mode for a remote or shared server.',
    );
  }
  const socketDir = socketOverride ? path.resolve(ROOT, socketOverride) : dataDir;
  // sockaddr_un caps the path; postgres appends "/.s.PGSQL.<port>" to this dir.
  if (socketDir.length > 90) {
    throw new Error(`Unix socket directory is too long for PostgreSQL: ${socketDir}`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL names no database');
  return {
    dataDir,
    socketDir,
    logFile: LOG_FILE,
    host,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username) || os.userInfo().username,
    password: decodeURIComponent(url.password),
    database,
  };
}

/** postgres server options for `pg_ctl -o`, which runs them through a shell. */
export function serverOptions(cfg) {
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  return [
    `-p ${cfg.port}`,
    `-k ${q(cfg.socketDir)}`,
    `-c listen_addresses=${q(cfg.host ? cfg.host.replace(/^\[|\]$/g, '') : '')}`,
  ].join(' ');
}

const pgEnv = (cfg) => ({ ...process.env, PGPASSWORD: cfg.password, PGCONNECT_TIMEOUT: '10' });

const run = (bin, args, opts = {}) =>
  execFileSync(bin, args.map(String), { cwd: ROOT, encoding: 'utf8', ...opts });

/** 'running' | 'stopped' | 'absent' — pg_ctl exits 0 / 3 / 4 respectively. */
export function clusterState(cfg) {
  if (!fs.existsSync(path.join(cfg.dataDir, 'PG_VERSION'))) return 'absent';
  const { status } = spawnSync('pg_ctl', ['-D', cfg.dataDir, 'status'], { stdio: 'ignore' });
  return status === 0 ? 'running' : 'stopped';
}

const portOwned = (cfg) =>
  new Promise((resolve) => {
    if (!cfg.host) return resolve(false);
    const socket = net
      .connect({ host: cfg.host.replace(/^\[|\]$/g, ''), port: cfg.port })
      .setTimeout(1000)
      .on('connect', () => (socket.destroy(), resolve(true)))
      .on('timeout', () => (socket.destroy(), resolve(false)))
      .on('error', () => resolve(false));
  });

function initCluster(cfg) {
  fs.mkdirSync(path.dirname(cfg.dataDir), { recursive: true });
  const args = ['-D', cfg.dataDir, '-U', cfg.user, '-E', 'UTF8', '--auth-local=trust'];
  // The socket is inside the repo and only this user can read it, so local
  // trust is fine; the TCP port is not, so it keeps the URL's own password.
  const pwDir = cfg.password ? fs.mkdtempSync(path.join(os.tmpdir(), 'cms-pg-')) : null;
  try {
    if (pwDir) {
      const pwFile = path.join(pwDir, 'pw');
      fs.writeFileSync(pwFile, cfg.password, { mode: 0o600 });
      args.push('--auth-host=scram-sha-256', `--pwfile=${pwFile}`);
    } else {
      args.push('--auth-host=trust');
    }
    console.log(`local-postgres: initialising cluster in ${cfg.dataDir}`);
    run('initdb', args, { stdio: 'inherit' });
  } finally {
    if (pwDir) fs.rmSync(pwDir, { recursive: true, force: true });
  }
}

function ensureDatabase(cfg) {
  const psql = ['-h', cfg.socketDir, '-p', cfg.port, '-U', cfg.user, '-d', 'postgres'];
  // psql does not interpolate :'vars' into -c, so quote the literal here;
  // doubling apostrophes is the whole of SQL string escaping.
  const literal = `'${cfg.database.replace(/'/g, "''")}'`;
  const exists = run(
    'psql',
    [...psql, '-tAc', `select 1 from pg_database where datname = ${literal}`],
    { env: pgEnv(cfg) },
  ).trim();
  if (exists === '1') return false;
  run('createdb', [...psql.slice(0, 6), cfg.database], { env: pgEnv(cfg), stdio: 'inherit' });
  return true;
}

async function start(cfg) {
  const initial = clusterState(cfg);
  // Ask before initialising: a busy port means this mode is the wrong one, and
  // the caller should not be left with a cluster they never got to use.
  if (initial !== 'running' && (await portOwned(cfg))) {
    throw new Error(
      `Something already listens on ${cfg.host}:${cfg.port} and it is not this cluster — ` +
        'stop it, or use the docker/system database mode instead.',
    );
  }
  if (initial === 'absent') initCluster(cfg);
  if (initial !== 'running') {
    run(
      'pg_ctl',
      ['-D', cfg.dataDir, '-l', cfg.logFile, '-o', serverOptions(cfg), '-w', '-t', '60', 'start'],
      { stdio: 'inherit' },
    );
  }
  const created = ensureDatabase(cfg);
  report(cfg, created ? 'running (database created)' : 'running');
}

function stop(cfg) {
  const state = clusterState(cfg);
  if (state !== 'running') {
    console.log(`local-postgres: nothing to stop — cluster is ${state}`);
    return;
  }
  run('pg_ctl', ['-D', cfg.dataDir, '-m', 'fast', '-w', '-t', '60', 'stop'], { stdio: 'inherit' });
  console.log('local-postgres: stopped');
}

function report(cfg, state) {
  // Never print the password: the connection facts are all that is useful.
  console.log(`local-postgres: ${state}`);
  console.log(`  data dir : ${cfg.dataDir}`);
  console.log(`  log      : ${cfg.logFile}`);
  console.log(`  listening: ${cfg.host ? `${cfg.host}:${cfg.port}` : '(socket only)'} · socket ${cfg.socketDir}`);
  console.log(`  database : ${cfg.database} (user ${cfg.user})`);
  console.log(`  psql/bench: PGHOST=${cfg.socketDir} PGPORT=${cfg.port} PGUSER=${cfg.user}`);
}

function status(cfg) {
  const state = clusterState(cfg);
  if (state !== 'running') {
    console.log(`local-postgres: ${state === 'absent' ? 'no cluster in ' + cfg.dataDir : 'stopped'}`);
    process.exitCode = 1;
    return;
  }
  report(cfg, 'running');
}

function readDatabaseUrl() {
  const env = {};
  for (const file of ['.env', '.env.local']) {
    const p = path.join(ROOT, file);
    if (fs.existsSync(p)) Object.assign(env, dotenvParse(fs.readFileSync(p, 'utf8')));
  }
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env, .env.local, or the environment)');
  return url;
}

const COMMANDS = { start, stop, status };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'status';
  const action = COMMANDS[command];
  if (!action) {
    console.error(`local-postgres: unknown command "${command}" — use start, stop, or status`);
    process.exit(2);
  }
  try {
    await action(clusterConfig(readDatabaseUrl()));
  } catch (err) {
    console.error(`local-postgres: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
