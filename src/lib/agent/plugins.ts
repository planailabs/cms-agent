/**
 * Generic agent-plugin support (Codex marketplace layout):
 *
 *   <root>/.agents/plugins/marketplace.json      — plugin catalog
 *   <plugin>/.codex-plugin/plugin.json           — manifest (.claude-plugin fallback)
 *   <plugin>/<manifest.skills ?? skills/>/<name>/SKILL.md — skills (frontmatter + body)
 *   <plugin>/<manifest.rules> or <plugin>/AGENTS.md       — always-on rules
 *
 * Rules are appended to every system prompt; skills are listed there and
 * loaded on demand via the use_skill tool (progressive disclosure). The root
 * is the app install dir (CMS_PLUGINS_ROOT, set by the nix wrapper) or the
 * repo root in dev.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PluginSkill {
  plugin: string;
  name: string;
  description: string;
  body: string;
}

export interface PluginRule {
  plugin: string;
  text: string;
}

export interface PluginRegistry {
  plugins: string[];
  skills: PluginSkill[];
  rules: PluginRule[];
}

const pluginsRoot = (): string => process.env.CMS_PLUGINS_ROOT || process.cwd();

// ── Frontmatter (minimal: plain values + folded '>' blocks, the two forms
// SKILL.md files use in the wild — not worth a YAML dependency) ─────────────

export function parseFrontmatter(md: string): { attrs: Record<string, string>; body: string } {
  const attrs: Record<string, string> = {};
  if (!md.startsWith('---\n')) return { attrs, body: md };
  const end = md.indexOf('\n---', 4);
  if (end < 0) return { attrs, body: md };
  const lines = md.slice(4, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) {
        block.push(lines[++i].trim());
      }
      value = block.join(' ').trim();
    }
    attrs[m[1]] = value.replace(/^["']|["']$/g, '');
  }
  return { attrs, body: md.slice(end + 4).replace(/^-*\n?/, '').trim() };
}

// ── Loading ──────────────────────────────────────────────────────────────

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const skillsFromDir = (plugin: string, skillsDir: string): PluginSkill[] => {
  if (!fs.existsSync(skillsDir)) return [];
  const skills: PluginSkill[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const { attrs, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    skills.push({
      plugin,
      name: attrs.name || entry.name,
      description: attrs.description ?? '',
      body,
    });
  }
  return skills;
};

const loadSkills = (plugin: string, dir: string, skillsRef: string): PluginSkill[] => {
  const skillsDir = path.resolve(dir, skillsRef);
  if (!skillsDir.startsWith(dir)) return [];
  return skillsFromDir(plugin, skillsDir);
};

/**
 * Skills carried by the managed site itself: <worktree>/.agents/skills/
 * (generic agent-conventions layout). Read fresh every time — the agent can
 * add or edit them mid-chat, and each chat has its own worktree.
 */
export function loadBranchSkills(worktreePath: string | undefined): PluginSkill[] {
  if (!worktreePath) return [];
  return skillsFromDir('site repo', path.join(worktreePath, '.agents', 'skills'));
}

const loadRules = (plugin: string, dir: string, rulesRef?: string): PluginRule[] => {
  const candidates: string[] = [];
  if (rulesRef) {
    const p = path.resolve(dir, rulesRef);
    if (p.startsWith(dir) && fs.existsSync(p)) {
      candidates.push(
        ...(fs.statSync(p).isDirectory()
          ? fs.readdirSync(p).filter((f) => f.endsWith('.md')).map((f) => path.join(p, f))
          : [p]),
      );
    }
  } else if (fs.existsSync(path.join(dir, 'AGENTS.md'))) {
    candidates.push(path.join(dir, 'AGENTS.md'));
  }
  return candidates.map((file) => ({ plugin, text: fs.readFileSync(file, 'utf8').trim() }));
};

let cache: PluginRegistry | null = null;

/** For tests (and a future reload endpoint). */
export function resetPluginCache(): void {
  cache = null;
}

export function loadPluginRegistry(): PluginRegistry {
  if (cache) return cache;
  const registry: PluginRegistry = { plugins: [], skills: [], rules: [] };
  const root = pluginsRoot();
  const marketplace = readJson(path.join(root, '.agents', 'plugins', 'marketplace.json'));
  const entries = Array.isArray(marketplace?.plugins) ? (marketplace.plugins as unknown[]) : [];

  for (const raw of entries) {
    const entry = raw as { name?: string; source?: { source?: string; path?: string } };
    if (entry.source?.source !== 'local' || !entry.source.path) continue;
    const dir = path.resolve(root, entry.source.path);
    if (!dir.startsWith(root)) continue; // marketplace must not escape the root
    const manifest =
      readJson(path.join(dir, '.codex-plugin', 'plugin.json')) ??
      readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    if (!manifest) {
      console.warn(`[plugins] ${entry.name ?? dir}: no plugin manifest found — skipped`);
      continue;
    }
    const name = (manifest.name as string) || entry.name || path.basename(dir);
    registry.plugins.push(name);
    registry.skills.push(...loadSkills(name, dir, (manifest.skills as string) ?? './skills/'));
    registry.rules.push(...loadRules(name, dir, manifest.rules as string | undefined));
  }

  cache = registry;
  return registry;
}

/** All skills visible to a chat: branch-local first (they win name clashes),
 *  then installed plugin skills. */
export function skillsForChat(worktreePath?: string): PluginSkill[] {
  const branch = loadBranchSkills(worktreePath);
  const taken = new Set(branch.map((s) => s.name.toLowerCase()));
  return [
    ...branch,
    ...loadPluginRegistry().skills.filter((s) => !taken.has(s.name.toLowerCase())),
  ];
}

/** System-prompt section: always-on rules + the on-demand skill list. */
export function pluginPromptSection(worktreePath?: string): string {
  const { rules } = loadPluginRegistry();
  const skills = skillsForChat(worktreePath);
  const parts: string[] = [];
  if (rules.length > 0) {
    parts.push(
      'Plugin rules — these ALWAYS apply to your work:\n\n' +
        rules.map((r) => `[${r.plugin}]\n${r.text}`).join('\n\n'),
    );
  }
  if (skills.length > 0) {
    parts.push(
      'Available skills — call use_skill with a name to load its full instructions ' +
        'when the task (or the user) calls for it:\n' +
        skills
          .map(
            (s) =>
              `- ${s.name}${s.plugin === 'site repo' ? ' (from the site repo)' : ''}: ${s.description.slice(0, 300)}`,
          )
          .join('\n'),
    );
  }
  return parts.join('\n\n');
}
