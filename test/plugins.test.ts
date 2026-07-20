/**
 * Agent plugin support — marketplace/manifest/skill/rule loading (Codex
 * plugin layout), the use_skill tool, and the prompt section. Fixture-based,
 * plus an integration check against the real ponytail submodule.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  loadBranchSkills,
  loadPluginRegistry,
  parseFrontmatter,
  pluginPromptSection,
  resetPluginCache,
  skillsForChat,
} from '@/lib/agent/plugins';

const REPO_ROOT = process.cwd();
const PONYTAIL = path.join(REPO_ROOT, 'plugins', 'ponytail', 'AGENTS.md');

let root: string;

const write = (rel: string, content: string): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-plugins-test-'));
  write(
    '.agents/plugins/marketplace.json',
    JSON.stringify({
      name: 'test-marketplace',
      plugins: [
        { name: 'demo', source: { source: 'local', path: './plugins/demo' } },
        { name: 'remote', source: { source: 'git', path: 'ignored' } },
        { name: 'escape', source: { source: 'local', path: '../../outside' } },
      ],
    }),
  );
  write(
    'plugins/demo/.codex-plugin/plugin.json',
    JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills/' }),
  );
  write(
    'plugins/demo/skills/hello/SKILL.md',
    '---\nname: hello\ndescription: >\n  Greets the user\n  warmly.\n---\n\nSay hello and offer help.\n',
  );
  write('plugins/demo/AGENTS.md', 'Always be excellent.\n');
});

afterEach(() => resetPluginCache());

describe('agent plugins', () => {
  it('parses frontmatter with plain and folded values', () => {
    const { attrs, body } = parseFrontmatter(
      '---\nname: x\ndescription: >\n  line one\n  line two\n---\n\nBody here.\n',
    );
    expect(attrs.name).toBe('x');
    expect(attrs.description).toBe('line one line two');
    expect(body).toBe('Body here.');
  });

  it('loads skills and rules from the marketplace, skipping non-local and escaping entries', () => {
    process.env.CMS_PLUGINS_ROOT = root;
    const reg = loadPluginRegistry();
    expect(reg.plugins).toEqual(['demo']);
    expect(reg.skills).toHaveLength(1);
    expect(reg.skills[0]).toMatchObject({
      plugin: 'demo',
      name: 'hello',
      description: 'Greets the user warmly.',
    });
    expect(reg.skills[0].body).toContain('Say hello');
    expect(reg.rules).toHaveLength(1);
    expect(reg.rules[0].text).toBe('Always be excellent.');
  });

  it('renders rules and the skill list into the prompt section', () => {
    process.env.CMS_PLUGINS_ROOT = root;
    const section = pluginPromptSection();
    expect(section).toContain('Always be excellent.');
    expect(section).toContain('- hello: Greets the user warmly.');
    expect(section).toContain('use_skill');
  });

  it('use_skill returns the body, and a helpful error for unknown names', async () => {
    process.env.CMS_PLUGINS_ROOT = root;
    const { registerSkillTools } = await import('@/lib/agent/tools/skillTools');
    const { getTool } = await import('@/lib/agent/tools/registry');
    registerSkillTools();
    const tool = getTool('use_skill')!;
    const ok = await tool.execute!({ name: 'Hello' }, {} as never);
    expect(ok).toContain('Say hello and offer help.');
    const err = await tool.execute!({ name: 'nope' }, {} as never);
    expect(err).toContain('Unknown skill');
    expect(err).toContain('hello');
  });

  it('loads branch-local skills from a worktree, shadowing installed ones', async () => {
    process.env.CMS_PLUGINS_ROOT = root;
    const wt = path.join(root, 'worktree');
    fs.mkdirSync(path.join(wt, '.agents', 'skills', 'site-style'), { recursive: true });
    fs.writeFileSync(
      path.join(wt, '.agents', 'skills', 'site-style', 'SKILL.md'),
      '---\nname: site-style\ndescription: House style rules.\n---\n\nUse sentence case.\n',
    );
    // Same name as the installed plugin skill — the branch one must win
    fs.mkdirSync(path.join(wt, '.agents', 'skills', 'hello'), { recursive: true });
    fs.writeFileSync(
      path.join(wt, '.agents', 'skills', 'hello', 'SKILL.md'),
      '---\nname: hello\ndescription: Site-specific greeting.\n---\n\nBranch hello wins.\n',
    );

    expect(loadBranchSkills(undefined)).toEqual([]);
    expect(loadBranchSkills(wt)).toHaveLength(2);

    const merged = skillsForChat(wt);
    expect(merged.filter((s) => s.name === 'hello')).toHaveLength(1);
    expect(merged.find((s) => s.name === 'hello')!.body).toContain('Branch hello wins.');

    const section = pluginPromptSection(wt);
    expect(section).toContain('site-style (from the site repo)');

    const { getTool } = await import('@/lib/agent/tools/registry');
    const { registerSkillTools } = await import('@/lib/agent/tools/skillTools');
    registerSkillTools();
    const out = await getTool('use_skill')!.execute!(
      { name: 'hello' },
      { worktreePath: wt } as never,
    );
    expect(out).toContain('Branch hello wins.');
  });

  it('loads admin skills from VAR_DIR/skills, between branch and plugins', async () => {
    process.env.CMS_PLUGINS_ROOT = root;
    const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-admin-skills-'));
    const prevVarDir = process.env.VAR_DIR;
    process.env.VAR_DIR = varDir;
    const { resetEnvCache } = await import('@/lib/env');
    resetEnvCache();
    try {
      const mk = (name: string, desc: string, body: string) => {
        fs.mkdirSync(path.join(varDir, 'skills', name), { recursive: true });
        fs.writeFileSync(
          path.join(varDir, 'skills', name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`,
        );
      };
      mk('ops-notes', 'Deployment conventions.', 'Admin body.');
      mk('hello', 'Admin greeting.', 'Admin hello.'); // clashes with plugin + branch

      const { loadAdminSkills } = await import('@/lib/agent/plugins');
      expect(loadAdminSkills().map((s) => s.name).sort()).toEqual(['hello', 'ops-notes']);

      // admin shadows the plugin skill of the same name…
      const merged = skillsForChat(undefined);
      expect(merged.filter((s) => s.name === 'hello')).toHaveLength(1);
      expect(merged.find((s) => s.name === 'hello')!.body).toContain('Admin hello.');

      // …but the branch skill shadows the admin one
      const wt = path.join(root, 'worktree');
      const withBranch = skillsForChat(wt);
      expect(withBranch.find((s) => s.name === 'hello')!.body).toContain('Branch hello wins.');
      expect(withBranch.map((s) => s.name)).toContain('ops-notes');

      expect(pluginPromptSection(undefined)).toContain('ops-notes (admin-provided)');

      // Admin rules: VAR_DIR/rules/*.md are always-on prompt rules
      fs.mkdirSync(path.join(varDir, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(varDir, 'rules', 'style.md'), 'Always be terse.\n');
      const { loadAdminRules } = await import('@/lib/agent/plugins');
      expect(loadAdminRules()).toEqual([{ plugin: 'admin', text: 'Always be terse.' }]);
      expect(pluginPromptSection(undefined)).toContain('[admin]\nAlways be terse.');
    } finally {
      process.env.VAR_DIR = prevVarDir;
      resetEnvCache();
    }
  });

  it.skipIf(!fs.existsSync(PONYTAIL))('loads the real plugin dirs (flake inputs)', () => {
    process.env.CMS_PLUGINS_ROOT = REPO_ROOT;
    const reg = loadPluginRegistry();
    expect(reg.plugins).toContain('ponytail');
    expect(reg.skills.map((s) => s.name)).toContain('ponytail');
    expect(reg.rules.some((r) => r.text.includes('lazy senior developer'))).toBe(true);
    if (fs.existsSync(path.join(REPO_ROOT, 'plugins', 'codebase-memory'))) {
      expect(reg.skills.map((s) => s.name)).toContain('codebase-memory');
    }
  });
});
