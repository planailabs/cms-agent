#!/usr/bin/env node
/**
 * Testbench orchestrator: boots the REAL production build (astro build +
 * node server.mjs with the native proxy) against a throwaway Postgres DB,
 * a throwaway site repo (examples/basic-site) with a local bare deploy
 * remote, and a throwaway VAR_DIR — then runs the scenario suite with
 * vitest and renders a verdict report. Real AI keys come from .env; the
 * judge model is JUDGE_MODEL (fallback OPENAI_MODEL).
 *
 *   pnpm bench                 # full suite (main phase + real-auth phase)
 *   pnpm bench --group api     # one group (api|ui|e2e|admin|proxy|recovery|auth)
 *   pnpm bench --grep 'name'   # vitest -t filter
 *   pnpm bench --keep          # keep DB/workspace for debugging
 *   pnpm bench --no-build      # skip the dist staleness check
 *
 * The auth group runs as its own phase: the server is rebooted WITHOUT
 * SKIP_AUTH and OIDC_ISSUER points at the mock IdP the 07-auth suite binds.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as dotenvParse } from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = {
  api: 'testbench/scenarios/01-api-probes.test.ts',
  ui: 'testbench/scenarios/02-ui-flows.test.ts',
  e2e: 'testbench/scenarios/03-e2e-agent.test.ts',
  admin: 'testbench/scenarios/04-admin.test.ts',
  proxy: 'testbench/scenarios/05-preview-proxy.test.ts',
  recovery: 'testbench/scenarios/06-recovery.test.ts',
  // Runs on its own server boot: SKIP_AUTH off, OIDC against an in-test mock IdP.
  auth: 'testbench/scenarios/07-auth.test.ts',
};

// ── args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args.splice(i, 1), true);
};
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const [, value] = args.splice(i, 2);
  return value ?? null;
};
const keep = flag('--keep');
const noBuild = flag('--no-build');
const grep = opt('--grep');
const groups = [];
let g;
while ((g = opt('--group'))) {
  if (!GROUPS[g]) fail(`unknown group '${g}' (api|ui|e2e|admin|proxy|recovery|auth)`);
  groups.push(GROUPS[g]);
}

function fail(msg) {
  console.error(`bench: ${msg}`);
  process.exit(1);
}

const run = (cmd, cmdArgs, opts = {}) => {
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (res.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (${res.status})`);
};

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// ── preflight ────────────────────────────────────────────────────────────
if (!process.env.PROXY_NATIVE_PATH || !fs.existsSync(process.env.PROXY_NATIVE_PATH)) {
  fail('PROXY_NATIVE_PATH missing — run inside `nix develop` (it supplies the native proxy addon)');
}
const dotenv = {
  ...dotenvParse(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')),
  ...(fs.existsSync(path.join(ROOT, '.env.local'))
    ? dotenvParse(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8'))
    : {}),
};
if (!dotenv.OPENAI_API_KEY || dotenv.OPENAI_API_KEY === 'sk-test' || !dotenv.OPENAI_MODEL) {
  fail('.env must provide a real OPENAI_API_KEY and OPENAI_MODEL — the bench runs real agent turns');
}
// createdb/dropdb take no connection string, so give libpq the same server
// DATABASE_URL names rather than the ambient peer-auth defaults — a repo-owned
// cluster (`pnpm run db:start`) listens on its own socket and port, and the
// bench's throwaway database has to be created on the server the app will use.
const pgEnv = (() => {
  const url = new URL(dotenv.DATABASE_URL);
  const socketDir = url.searchParams.get('host');
  return {
    PGHOST: socketDir ? path.resolve(ROOT, socketDir) : url.hostname || '127.0.0.1',
    PGPORT: url.port || '5432',
    PGDATABASE: 'postgres', // maintenance connection: the bench DB does not exist yet
    ...(url.username ? { PGUSER: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
  };
})();
const pgSpawn = (cmd, cmdArgs, opts = {}) =>
  spawnSync(cmd, cmdArgs, { cwd: ROOT, env: { ...process.env, ...pgEnv }, ...opts });

if (pgSpawn('psql', ['-c', 'select 1'], { stdio: 'ignore' }).status !== 0) {
  fail(
    `psql cannot reach ${pgEnv.PGHOST}:${pgEnv.PGPORT} as ${pgEnv.PGUSER ?? '(default user)'} — ` +
      'the bench needs the PostgreSQL from DATABASE_URL running (`pnpm run db:start` starts a local one)',
  );
}

// ── build if stale ───────────────────────────────────────────────────────
const newestMtime = (dir) => {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
};
const entry = path.join(ROOT, 'dist', 'server', 'entry.mjs');
if (!noBuild) {
  const stale =
    !fs.existsSync(entry) ||
    fs.statSync(entry).mtimeMs <
      Math.max(newestMtime(path.join(ROOT, 'src')), fs.statSync(path.join(ROOT, 'astro.config.mjs')).mtimeMs);
  if (stale) {
    console.log('bench: building production bundle …');
    run('pnpm', ['build']);
  }
}

// ── throwaway resources ──────────────────────────────────────────────────
const stamp = Date.now();
const dbName = `cms_bench_${stamp}`;
const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'cms-bench-'));
const sitePath = path.join(work, 'site');
const deployRemotePath = path.join(work, 'deploy.git');
const varDir = path.join(work, 'var');
const resultsDir = path.join(ROOT, 'testbench', 'results', new Date(stamp).toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(varDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

console.log(`bench: db=${dbName} work=${work}`);
if (pgSpawn('createdb', [dbName], { stdio: 'inherit' }).status !== 0) fail(`createdb ${dbName} failed`);

const dbUrl = new URL(dotenv.DATABASE_URL);
dbUrl.pathname = `/${dbName}`;
const benchDbUrl = dbUrl.toString();

const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: benchDbUrl },
});
if (migrate.status !== 0) {
  console.log('bench: migrate deploy failed — falling back to db push');
  run('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: benchDbUrl },
  });
}

run('bash', ['scripts/setup-dev-site.sh', 'basic-site', sitePath]);
run('git', ['init', '--bare', '-q', deployRemotePath]);
run('git', ['-C', sitePath, 'remote', 'add', 'origin', deployRemotePath]);
run('git', ['-C', sitePath, 'push', '-q', 'origin', 'main']);

const cmsPort = await freePort();
const proxyPort = await freePort();
const idpPort = await freePort();
const baseUrl = `http://localhost:${proxyPort}`;

const serverEnv = { ...process.env, ...dotenv };
delete serverEnv.CMS_TEST_DB;
Object.assign(serverEnv, {
  SKIP_AUTH: 'true',
  DATABASE_URL: benchDbUrl,
  REPO_PATH: sitePath,
  VAR_DIR: varDir,
  BASE_DOMAIN: 'localhost',
  HOST: '127.0.0.1',
  PORT: String(cmsPort),
  PROXY_LISTEN: `127.0.0.1:${proxyPort}`,
  CMS_UPSTREAM: `127.0.0.1:${cmsPort}`,
  PUBLIC_SCHEME: 'http',
  // Preview URLs carry the proxy port (same as the dev Procfile) — without
  // it the workspace iframes point at <branch>.localhost:80 and never load.
  DEV_PORT_CARRY: '1',
  DEPLOY_FLOW: 'git-push',
  DEPLOY_GIT_REMOTE: 'origin',
  BETTER_AUTH_URL: baseUrl,
  OIDC_ISSUER: 'https://idp.invalid',
  OIDC_CLIENT_ID: 'bench',
  OIDC_CLIENT_SECRET: 'bench-secret',
  ROUTE_MAPPINGS: '',
  // The bench boots the production build, where a metrics token is mandatory
  // — and having one lets the probes exercise the gate rather than skip it.
  METRICS_TOKEN: 'bench-metrics-token-0123456789',
});

// The auth phase reboots the SAME workspace/DB with the real auth stack:
// SKIP_AUTH absent, OIDC pointed at the port the 07-auth suite binds its
// instrumented mock IdP to (discovery is fetched lazily at first sign-in,
// so the server can boot before the IdP listens).
const authServerEnv = { ...serverEnv };
delete authServerEnv.SKIP_AUTH;
Object.assign(authServerEnv, {
  OIDC_ISSUER: `http://127.0.0.1:${idpPort}`,
  OIDC_CLIENT_ID: 'bench-client',
  OIDC_CLIENT_SECRET: 'bench-client-secret',
  ALLOWED_EMAILS: 'alice@bench.test',
  ALLOWED_EMAIL_DOMAIN: 'team.bench.test',
  BETTER_AUTH_SECRET: serverEnv.BETTER_AUTH_SECRET || 'bench-better-auth-secret-0123456789',
});

const writeBlob = (name, envObj, extra = {}) => {
  const blob = {
    baseUrl,
    proxyPort,
    env: Object.fromEntries(Object.entries(envObj).map(([k, v]) => [k, String(v)])),
    work,
    sitePath,
    deployRemotePath,
    ...extra,
  };
  const file = path.join(work, name);
  fs.writeFileSync(file, JSON.stringify(blob, null, 2));
  return file;
};
const benchEnvFile = writeBlob('bench-env.json', serverEnv);
const authEnvFile = writeBlob('bench-env-auth.json', authServerEnv, { authIdpPort: idpPort });

// ── boot / teardown ──────────────────────────────────────────────────────
const logPath = path.join(resultsDir, 'server.log');
// Log via an fd, not parent-side pipes — a --keep server must survive our exit.
const logFd = fs.openSync(logPath, 'a');
let server = null;

const bootServer = (envObj) => {
  server = spawn('bash', ['scripts/launch-with-sandbox.sh', 'node', 'server.mjs'], {
    cwd: ROOT,
    env: envObj,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
};

const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });

const killServer = async () => {
  if (!server) return;
  const pid = server.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  // The next phase reuses the same ports — wait until they are actually
  // released (the node server can outlive the proxy), escalating to SIGKILL.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await portFree(cmsPort)) && (await portFree(proxyPort))) break;
    if (Date.now() > deadline - 7_000) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  server = null;
};

let tornDown = false;
const teardown = () => {
  if (tornDown) return;
  tornDown = true;
  if (keep && server) {
    console.log(
      `bench: --keep — server pid ${server.pid} still running at ${baseUrl}; db ${dbName}; work ${work}`,
    );
    server.unref();
    return;
  }
  // Sync kill (signal handlers can't await): SIGTERM + grace is enough here —
  // only dropdb needs the connections gone, not the ports.
  if (server) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    spawnSync('sleep', ['2']);
    server = null;
  }
  pgSpawn('dropdb', ['--if-exists', dbName], { stdio: 'inherit' });
  // The server leaves the sandbox squashfuse mounted under VAR_DIR — rm
  // would otherwise walk into (and fail on) the mount.
  const mntDir = path.join(varDir, 'sandbox', 'mnt');
  if (fs.existsSync(mntDir)) {
    for (const m of fs.readdirSync(mntDir)) {
      const mnt = path.join(mntDir, m);
      if (spawnSync('fusermount3', ['-u', mnt]).status !== 0) spawnSync('fusermount', ['-u', mnt]);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
};
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  teardown();
  process.exit(143);
});

// 401 counts as healthy: the auth phase gates /api/version behind a session.
const waitHealthy = async () => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;
    try {
      const res = await fetch(`${baseUrl}/api/version`);
      if (res.status === 200 || res.status === 401) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

// ── run scenarios (auth needs its own server boot) ───────────────────────
const selected = groups.length > 0 ? groups : Object.values(GROUPS);
const mainFiles = selected.filter((f) => f !== GROUPS.auth);
const phases = [];
if (mainFiles.length > 0) {
  phases.push({ name: 'main', files: mainFiles, env: serverEnv, envFile: benchEnvFile });
}
if (selected.includes(GROUPS.auth)) {
  phases.push({ name: 'auth', files: [GROUPS.auth], env: authServerEnv, envFile: authEnvFile });
}

let anyFailed = false;
for (const phase of phases) {
  await killServer();
  bootServer(phase.env);
  if (!(await waitHealthy())) {
    console.error(`bench: ${phase.name} server failed to become healthy; last log lines:`);
    try {
      console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n'));
    } catch {
      /* no log */
    }
    teardown();
    process.exit(1);
  }
  console.log(`bench: ${phase.name} server healthy at ${baseUrl}`);

  const result = spawnSync(
    'npx',
    [
      'vitest',
      'run',
      '--config',
      'testbench/vitest.config.ts',
      ...phase.files,
      ...(grep ? ['-t', grep] : []),
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        BENCH_ENV_FILE: phase.envFile,
        BENCH_BASE_URL: baseUrl,
        BENCH_RESULTS_DIR: resultsDir,
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1',
      },
    },
  );
  if (result.status !== 0) anyFailed = true;
}

// ── report ───────────────────────────────────────────────────────────────
const verdictsPath = path.join(resultsDir, 'verdicts.jsonl');
if (fs.existsSync(verdictsPath)) {
  const verdicts = fs
    .readFileSync(verdictsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const passed = verdicts.filter((v) => v.pass).length;
  const rows = verdicts
    .map(
      (v) =>
        `| ${v.scenario} | ${v.step.replace(/\|/g, '\\|').slice(0, 80)} | ${v.pass ? '✅' : '❌'} | ${v.source} | ${v.reasoning.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`,
    )
    .join('\n');
  const md = `# Testbench run ${new Date(stamp).toISOString()}

**${passed}/${verdicts.length} checks passed** — judge model: \`${dotenv.JUDGE_MODEL ?? dotenv.OPENAI_MODEL}\`, agent model: \`${dotenv.OPENAI_MODEL}\`

| Scenario | Step | Verdict | Source | Reasoning |
|---|---|---|---|---|
${rows}
`;
  fs.writeFileSync(path.join(resultsDir, 'report.md'), md);
  fs.writeFileSync(path.join(resultsDir, 'report.json'), JSON.stringify(verdicts, null, 2));
  console.log(`bench: ${passed}/${verdicts.length} checks passed — report: ${path.relative(ROOT, resultsDir)}/report.md`);
} else {
  console.log('bench: no verdicts recorded');
}

teardown();
process.exit(anyFailed ? 1 : 0);
