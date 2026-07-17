/**
 * Sandbox jail — real bwrap + squashfs env (built by launch-with-sandbox.sh,
 * which exports SANDBOX_DIR). Skipped when bwrap or the env dir is absent.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasBwrap = spawnSync('bwrap', ['--version']).status === 0;
const hasEnv = !!process.env.SANDBOX_DIR;
const run = describe.skipIf(!hasBwrap || !hasEnv);

let sandbox: typeof import('@/lib/sandbox');
let tmp: string;
let work: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-sbx-'));
  process.env.VAR_DIR = path.join(tmp, 'var');
  process.env.SANDBOX_NODE_MAJOR = '22';
  process.env.SANDBOX_ALLOW_NETWORK = '1';
  const { resetEnvCache } = await import('@/lib/env');
  resetEnvCache();
  sandbox = await import('@/lib/sandbox');
  work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
});

afterAll(() => {
  if (!tmp) return;
  // Best-effort: unmount any squashfuse mount, make extracted (read-only nix
  // store) dirs writable, then remove.
  spawnSync('sh', ['-c', `fusermount -u ${tmp}/var/sandbox/mnt/* 2>/dev/null; true`]);
  spawnSync('chmod', ['-R', 'u+w', tmp]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

run('bubblewrap sandbox', () => {
  it('resolves node/npm/sh from the sandbox PATH only', async () => {
    const sb = await sandbox.ensureSandbox('22');
    const r = await sandbox.runSandboxed(sb, 'node --version; command -v npm; command -v sh', {
      cwd: work,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^v22\./);
    expect(r.stdout).toContain('/bin/npm');
  });

  it('overshadows the store: only the sandbox closure is visible', async () => {
    const sb = await sandbox.ensureSandbox('22');
    const r = await sandbox.runSandboxed(sb, 'ls /nix/store | wc -l', { cwd: work });
    // The app's real store has thousands of paths; the sandbox closure is tiny.
    expect(Number(r.stdout.trim())).toBeLessThan(200);
  });

  it('has a deny-by-default rootfs (only mounted dirs exist)', async () => {
    const sb = await sandbox.ensureSandbox('22');
    const r = await sandbox.runSandboxed(sb, 'ls -1 /', { cwd: work });
    const entries = r.stdout.trim().split('\n').filter(Boolean).sort();
    expect(entries).toEqual(
      expect.arrayContaining(['bin', 'dev', 'home', 'nix', 'proc', 'tmp', 'usr', 'work']),
    );
    // No host dirs leaked in
    expect(entries).not.toContain('srv');
    expect(entries).not.toContain('root');
    // /etc exists only for DNS — just the resolver files, no host secrets
    const etc = await sandbox.runSandboxed(sb, 'ls -1 /etc', { cwd: work });
    const etcEntries = etc.stdout.trim().split('\n').filter(Boolean);
    expect(etcEntries.sort()).toEqual(['hosts', 'nsswitch.conf', 'resolv.conf']);
    expect(etcEntries).not.toContain('passwd');
    expect(etcEntries).not.toContain('shadow');
  });

  it('makes the worktree writable, the store read-only, HOME writable', async () => {
    const sb = await sandbox.ensureSandbox('22');
    const r = await sandbox.runSandboxed(
      sb,
      'echo ok > /work/w.txt && cat /work/w.txt; ' +
        '(echo x > /nix/store/x 2>/dev/null && echo STORE_WRITABLE || echo store-ro); ' +
        'touch /home/sandbox/h && echo home-ok',
      { cwd: work },
    );
    expect(r.stdout).toContain('ok');
    expect(r.stdout).toContain('store-ro');
    expect(r.stdout).toContain('home-ok');
    expect(fs.existsSync(path.join(work, 'w.txt'))).toBe(true);
  });

  it('gives each session its own HOME', async () => {
    const sb = await sandbox.ensureSandbox('22');
    await sandbox.runSandboxed(sb, 'echo SECRET_A > /home/sandbox/marker', {
      cwd: work,
      sessionKey: 'a',
    });
    const r = await sandbox.runSandboxed(sb, 'cat /home/sandbox/marker 2>/dev/null || echo empty', {
      cwd: work,
      sessionKey: 'b',
    });
    // Session b must not see session a's HOME
    expect(r.stdout).not.toContain('SECRET_A');
    expect(r.stdout.trim()).toBe('empty');
  });

  it('honors the network toggle', async () => {
    const sb = await sandbox.ensureSandbox('22');
    // Off → the loopback interface is the only one (no host net namespace)
    process.env.SANDBOX_ALLOW_NETWORK = '0';
    (await import('@/lib/env')).resetEnvCache();
    const off = await sandbox.runSandboxed(sb, 'node -e "console.log(Object.keys(require(\\"os\\").networkInterfaces()).join(\\",\\"))"', { cwd: work });
    process.env.SANDBOX_ALLOW_NETWORK = '1';
    (await import('@/lib/env')).resetEnvCache();
    expect(off.stdout.trim()).toBe('lo');
  });
});
