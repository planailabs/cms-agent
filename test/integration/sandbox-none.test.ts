/**
 * SANDBOX_MODE=none (the macOS/dev fallback): commands run with the
 * `nix develop .#sandbox-node<major>` shell's PATH and a scrubbed env.
 * Linux-runnable — the mode itself is platform-independent; only its
 * default (Darwin) is platform-specific. Needs nix (like the launcher).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { ensureSandbox, runSandboxed, sandboxCommand, sandboxHasBin } from '@/lib/sandbox';

let work: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-sbnone-'));
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  process.env.VAR_DIR = path.join(base, 'var');
  process.env.SANDBOX_MODE = 'none';
  process.env.CANARY_SECRET = 'must-not-leak';
  resetEnvCache();
});

describe('sandbox mode none', () => {
  it('resolves the dev shell and runs commands with a scrubbed env', async () => {
    const sb = await ensureSandbox();
    expect(sb.mode).toBe('none');
    expect(sb.shellPath).toContain('/nix/store/');

    const r = await runSandboxed(
      sb,
      'node --version && echo "H=$HOME" && echo "C=${CANARY_SECRET:-unset}" && pwd',
      { cwd: work, sessionKey: 'none-test', timeoutMs: 60_000 },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^v26\./);
    expect(r.stdout).toContain(`H=${path.join(path.resolve(process.env.VAR_DIR!), 'sandbox', 'home', 'none-test')}`);
    expect(r.stdout).toContain('C=unset');
    expect(r.stdout).toContain(work);
  }, 600_000);

  it('sandboxCommand wraps with env -i and the session home', async () => {
    const sb = await ensureSandbox();
    const { command, args } = sandboxCommand(sb, ['node', '-e', 'console.log(process.env.HOME + "|" + (process.env.CANARY_SECRET ?? "unset"))'], {
      cwd: work,
      sessionKey: 'none-test',
    });
    const r = spawnSync(command, args, { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      `${path.join(path.resolve(process.env.VAR_DIR!), 'sandbox', 'home', 'none-test')}|unset`,
    );
  }, 120_000);

  it('sandboxHasBin checks the shell PATH', async () => {
    const sb = await ensureSandbox();
    expect(sandboxHasBin(sb, 'node')).toBe(true);
    expect(sandboxHasBin(sb, 'definitely-not-a-binary-xyz')).toBe(false);
  }, 60_000);
});
