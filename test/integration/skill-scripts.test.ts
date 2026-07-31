/**
 * Skill scripts in the real jail: what a script can actually reach.
 *
 * The unit tests assert which options the tool passes; these assert that
 * bubblewrap honours them — a read-only worktree really refuses writes, the
 * skill's own directory is mounted but not writable, and the network is gone
 * unless the script declared it. Run through scripts/launch-with-sandbox.sh.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { resetPluginCache } from '@/lib/agent/plugins';
import { toolsForPhase, type ToolContext } from '@/lib/agent/tools/registry';
import '@/lib/agent/handler'; // registers run_skill_script

let base: string;
let worktree: string;
const saved = { root: process.env.CMS_PLUGINS_ROOT, varDir: process.env.VAR_DIR };

const write = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

const run = async (script: string, args: string[] = []) => {
  const tool = toolsForPhase('execute', 'workflow').find((t) => t.name === 'run_skill_script')!;
  const raw = await tool.execute!(
    { skill: 'probe', script, args, timeoutSeconds: 120 },
    { chatId: 'skillscript-it', worktreePath: worktree, workflowPhase: 'execute' } as ToolContext,
  );
  return JSON.parse(raw) as { exitCode: number | string; stdout: string; stderr: string };
};

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-skillscript-it-'));
  worktree = path.join(base, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'existing.txt'), 'hello\n');

  const skillDir = path.join(base, 'plugins', 'demo', 'skills', 'probe');
  write(
    path.join(base, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'demo', source: { source: 'local', path: './plugins/demo' } }] }),
  );
  write(path.join(base, 'plugins', 'demo', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'demo' }));

  // Reports what the jail actually allows, rather than trusting the flags.
  write(
    path.join(skillDir, 'scripts', 'probe.sh'),
    `#!/bin/sh
echo "arg1=$1"
echo "cwd=$(pwd)"
echo "sees-worktree=$(test -f /work/existing.txt && echo yes || echo no)"
echo "can-write-work=$( (touch /work/probe-wrote 2>/dev/null && echo yes) || echo no)"
echo "can-write-skill=$( (touch /skill/probe-wrote 2>/dev/null && echo yes) || echo no)"
echo "has-resolv=$(test -f /etc/resolv.conf && echo yes || echo no)"
`,
  );
  write(
    path.join(skillDir, 'scripts', 'writer.sh'),
    `#!/bin/sh
echo written > /work/writer-was-here.txt
echo "has-resolv=$(test -f /etc/resolv.conf && echo yes || echo no)"
`,
  );
  write(
    path.join(skillDir, 'SKILL.md'),
    `---
name: probe
description: Reports what the sandbox allows
scripts:
  - id: probe
    run: sh scripts/probe.sh
    description: Report the jail's limits
  - id: writer
    run: sh scripts/writer.sh
    description: Write into the worktree
    flags: [write, network]
---

Body.
`,
  );

  process.env.CMS_PLUGINS_ROOT = base;
  process.env.VAR_DIR = path.join(base, 'var');
  resetEnvCache();
  resetPluginCache();
}, 60_000);

afterAll(() => {
  process.env.CMS_PLUGINS_ROOT = saved.root;
  process.env.VAR_DIR = saved.varDir;
  resetEnvCache();
  resetPluginCache();
  // The sandbox leaves its squashfs mounted inside VAR_DIR; rm -rf over a
  // live mount fails with ENOSYS. Best-effort — never fail the suite here.
  const mnt = path.join(base, 'var', 'sandbox', 'mnt');
  if (fs.existsSync(mnt)) {
    for (const entry of fs.readdirSync(mnt)) {
      spawnSync('fusermount3', ['-u', path.join(mnt, entry)]);
    }
  }
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* a mount that would not release — the temp dir is the OS's problem now */
  }
});

describe('skill scripts in the jail', () => {
  it('runs with the worktree and its own skill dir, both read-only by default', async () => {
    const r = await run('probe', ['hello']);
    expect(r.exitCode, r.stderr).toBe(0);
    // Arguments arrive as argv, not through a shell.
    expect(r.stdout).toContain('arg1=hello');
    expect(r.stdout).toContain('cwd=/work');
    expect(r.stdout).toContain('sees-worktree=yes');
    // The declaration carried no flags, so none of these may be true.
    expect(r.stdout).toContain('can-write-work=no');
    expect(r.stdout).toContain('can-write-skill=no');
    expect(r.stdout).toContain('has-resolv=no');
    expect(fs.existsSync(path.join(worktree, 'probe-wrote'))).toBe(false);
  }, 120_000);

  it('writes only when the skill declared it', async () => {
    const r = await run('writer');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(worktree, 'writer-was-here.txt'), 'utf8')).toContain('written');
    // Same declaration asked for the network, so the resolver is there.
    expect(r.stdout).toContain('has-resolv=yes');
  }, 120_000);

  it('does not let an argument turn into shell syntax', async () => {
    const r = await run('probe', ['; touch /work/injected']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('arg1=; touch /work/injected');
    expect(fs.existsSync(path.join(worktree, 'injected'))).toBe(false);
  }, 120_000);
});
