/**
 * Skill scripts: what a skill may run, where the declaration came from, and
 * what the sandbox is told about it.
 *
 * The load-bearing rule is that a DERIVED script — one only mentioned in a
 * skill's prose — never carries a flag. Prose is evidence that something is
 * runnable, never that it may write to the site, reach the network, or run
 * while the agent is still planning.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({
  calls: [] as Array<{ argv: string[]; opts: Record<string, unknown> }>,
  mode: 'bwrap' as 'bwrap' | 'none',
}));

vi.mock('@/lib/sandbox', () => ({
  ensureSandbox: async () => ({ mode: sandbox.mode }),
  execSandboxed: async (_sb: unknown, argv: string[], opts: Record<string, unknown>) => {
    sandbox.calls.push({ argv, opts });
    return { code: 0, stdout: 'ran', stderr: '', timedOut: false };
  },
}));

import { resetEnvCache } from '@/lib/env';
import { loadPluginRegistry, parseFrontmatter, resetPluginCache } from '@/lib/agent/plugins';
import { SKILL_MOUNT } from '@/lib/agent/tools/skillScriptTools';
import { toolsForPhase } from '@/lib/agent/tools/registry';
import type { ToolContext } from '@/lib/agent/tools/registry';
import '@/lib/agent/handler'; // registers the tool

let root: string;
let varDir: string;
const saved = { root: process.env.CMS_PLUGINS_ROOT, varDir: process.env.VAR_DIR };

const write = (rel: string, body: string): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

const skills = () => {
  resetPluginCache();
  return loadPluginRegistry().skills;
};
const skill = (name: string) => skills().find((s) => s.name === name)!;

const runTool = async (
  input: Record<string, unknown>,
  phase: 'plan' | 'execute' = 'execute',
): Promise<Record<string, unknown>> => {
  const tool = toolsForPhase(phase, 'workflow').find((t) => t.name === 'run_skill_script')!;
  const raw = await tool.execute!(
    { args: [], timeoutSeconds: 120, ...input },
    { chatId: 'chat-1', worktreePath: '/tmp/does-not-matter', workflowPhase: phase } as ToolContext,
  );
  return JSON.parse(raw) as Record<string, unknown>;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-skillscripts-'));
  varDir = path.join(root, 'var');
  fs.mkdirSync(varDir, { recursive: true });

  write(
    '.agents/plugins/marketplace.json',
    JSON.stringify({ plugins: [{ name: 'demo', source: { source: 'local', path: './plugins/demo' } }] }),
  );
  write('plugins/demo/.codex-plugin/plugin.json', JSON.stringify({ name: 'demo' }));
  // Exists, and is outside every skill dir: only containment can reject it,
  // so the escape fixtures below cannot pass by being absent.
  write('plugins/demo/shared/scripts/evil.sh', 'echo pwned\n');

  // Declared: one good entry plus four that must each be rejected on their own.
  write('plugins/demo/skills/checker/scripts/check.mjs', 'console.log("ok")\n');
  write('plugins/demo/skills/checker/scripts/fix.py', 'print("fixed")\n');
  write(
    'plugins/demo/skills/checker/SKILL.md',
    `---
name: checker
description: Check things
scripts:
  - id: check
    run: node scripts/check.mjs
    description: Report problems
  - id: fix
    run: python3 scripts/fix.py
    description: Fix them in place
    flags: [write, network, plan]
  - id: no-desc
    run: node scripts/check.mjs
  - id: escapes
    run: sh ../../shared/scripts/evil.sh
    description: Should never load — exists, but outside the skill
  - id: exotic
    run: ruby scripts/check.mjs
    description: No interpreter for this
  - id: missing
    run: node scripts/nope.mjs
    description: Not a file
---

Body.
`,
  );

  // Undeclared: the script exists only in prose.
  write('plugins/demo/skills/prosy/scripts/analyze.py', 'print(1)\n');
  write('plugins/demo/skills/prosy/scripts/other.sh', 'echo hi\n');
  write(
    'plugins/demo/skills/prosy/SKILL.md',
    `---
name: prosy
description: Mentions its script in prose
---

To audit the site run \`python3 scripts/analyze.py --deep\` and read the report.
Ignore ../../shared/scripts/evil.sh (real file, outside this skill) and
scripts/absent.sh (inside, but not there).
`,
  );

  // Overlay target: prose would derive nothing useful.
  write('plugins/demo/skills/vendored/scripts/run.sh', 'echo vendored\n');
  write(
    'plugins/demo/skills/vendored/SKILL.md',
    '---\nname: vendored\ndescription: Third-party skill\n---\n\nNo runnable mention here.\n',
  );

  process.env.CMS_PLUGINS_ROOT = root;
  process.env.VAR_DIR = varDir;
  resetEnvCache();
});

afterAll(() => {
  process.env.CMS_PLUGINS_ROOT = saved.root;
  process.env.VAR_DIR = saved.varDir;
  resetEnvCache();
  resetPluginCache();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  sandbox.calls.length = 0;
  sandbox.mode = 'bwrap';
  fs.rmSync(path.join(varDir, 'skill-scripts.json'), { force: true });
  resetPluginCache();
});

describe('declared scripts', () => {
  it('keeps the well-formed entries and drops each broken one', () => {
    const s = skill('checker');
    expect(s.scripts.map((x) => x.id)).toEqual(['check', 'fix']);
    // no-desc: unpickable by the model. escapes: outside the skill.
    // exotic: no such interpreter in the jail. missing: not a file.
    expect(s.scripts.every((x) => x.origin === 'declared')).toBe(true);
  });

  it('carries declared flags, and refuses plan for a script that writes', () => {
    const s = skill('checker');
    expect(s.scripts.find((x) => x.id === 'check')!.flags).toEqual({});
    // `plan` was declared alongside `write` — a script that edits the site is
    // not a planning tool, whatever it claims.
    expect(s.scripts.find((x) => x.id === 'fix')!.flags).toEqual({ write: true, network: true });
  });
});

describe('derived scripts', () => {
  it('picks up a script the body mentions, without its example arguments', () => {
    const s = skill('prosy');
    expect(s.scripts).toHaveLength(1);
    const [script] = s.scripts;
    expect(script.id).toBe('analyze');
    expect(script.origin).toBe('derived');
    // --deep came from an example line: the model passes its own arguments.
    expect(script.argv).toEqual(['python3', 'scripts/analyze.py']);
    expect(script.description).toContain('audit the site');
  });

  it('never widens a derived script', () => {
    expect(skill('prosy').scripts[0].flags).toEqual({});
  });

  it('ignores mentions that escape the skill or do not exist', () => {
    // other.sh exists but is never mentioned; evil.sh escapes; absent.sh is absent.
    expect(skill('prosy').scripts.map((s) => s.id)).toEqual(['analyze']);
  });
});

describe('admin overlay', () => {
  const overlay = (json: unknown) =>
    fs.writeFileSync(path.join(varDir, 'skill-scripts.json'), JSON.stringify(json));

  it('is the only way a vendored skill gains a script or a flag', () => {
    expect(skill('vendored').scripts).toHaveLength(0);
    overlay({
      'demo/vendored': {
        scripts: [
          { id: 'run', run: 'sh scripts/run.sh', description: 'Run it', flags: ['write'] },
        ],
      },
    });
    const [script] = skill('vendored').scripts;
    expect(script.origin).toBe('overlay');
    expect(script.flags).toEqual({ write: true });
  });

  it('replaces what the skill declared for itself', () => {
    overlay({
      'demo/checker': { scripts: [{ id: 'only', run: 'node scripts/check.mjs', description: 'Just this' }] },
    });
    expect(skill('checker').scripts.map((s) => s.id)).toEqual(['only']);
  });

  it('survives an unreadable overlay file', () => {
    fs.writeFileSync(path.join(varDir, 'skill-scripts.json'), '{ not json');
    expect(skill('checker').scripts.map((s) => s.id)).toEqual(['check', 'fix']);
  });
});

describe('run_skill_script', () => {
  it('runs a declared script with the skill mounted read-only', async () => {
    const out = await runTool({ skill: 'checker', script: 'check', args: ['--json'] });
    expect(out.exitCode).toBe(0);
    const [call] = sandbox.calls;
    expect(call.argv).toEqual(['node', `${SKILL_MOUNT}/scripts/check.mjs`, '--json']);
    expect(call.opts.extraRoBinds).toEqual([[skill('checker').dir, SKILL_MOUNT]]);
  });

  it('gives a script without flags a read-only worktree and no network', async () => {
    await runTool({ skill: 'checker', script: 'check' });
    expect(sandbox.calls[0].opts).toMatchObject({ readOnlyWorktree: true, network: false });
  });

  it('honours declared flags', async () => {
    await runTool({ skill: 'checker', script: 'fix' });
    expect(sandbox.calls[0].opts).toMatchObject({ readOnlyWorktree: false, network: true });
  });

  it('refuses a script the skill does not declare', async () => {
    const out = await runTool({ skill: 'checker', script: '../../../bin/sh' });
    expect(String(out.error)).toMatch(/has no script/);
    expect(sandbox.calls).toHaveLength(0);
  });

  it('refuses an unknown skill', async () => {
    const out = await runTool({ skill: 'nope', script: 'check' });
    expect(String(out.error)).toMatch(/Unknown skill/);
    expect(sandbox.calls).toHaveLength(0);
  });

  it('runs in the plan phase only when the script says it is safe there', async () => {
    const denied = await runTool({ skill: 'checker', script: 'check' }, 'plan');
    expect(String(denied.error)).toMatch(/only in the execute phase/);
    expect(sandbox.calls).toHaveLength(0);
  });

  it('uses the host path when there is no jail to mount into', async () => {
    sandbox.mode = 'none';
    await runTool({ skill: 'checker', script: 'check' });
    expect(sandbox.calls[0].argv[1]).toBe(path.join(skill('checker').dir, 'scripts/check.mjs'));
    expect(sandbox.calls[0].opts.extraRoBinds).toEqual([]);
  });
});

describe('frontmatter that is not YAML', () => {
  it('is read leniently rather than costing the skill its description', () => {
    // Real third-party skills write this: an unquoted scalar with a colon.
    const { attrs, body } = parseFrontmatter(
      '---\nname: cbm\ndescription: Use the graph. Triggers on: explore, trace\n---\n\nBody.\n',
    );
    expect(attrs.name).toBe('cbm');
    expect(attrs.description).toBe('Use the graph. Triggers on: explore, trace');
    expect(body).toBe('Body.');
  });
});
