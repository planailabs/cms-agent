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
import { parse as parseYaml } from 'yaml';
import { env } from '@/lib/env';
import { resolveSkillScripts, type SkillScript } from './skillScripts';

export interface PluginSkill {
  plugin: string;
  name: string;
  description: string;
  body: string;
  /** Directory holding SKILL.md — bound read-only when a script of it runs. */
  dir: string;
  /** Runnable scripts (declared, derived from the body, or admin overlay). */
  scripts: SkillScript[];
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

// ── Frontmatter ─────────────────────────────────────────────────────────────

/** String frontmatter value, or '' for anything that is not one. */
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Last resort for frontmatter strict YAML rejects: read `key: value` lines
 * and folded blocks, taking the rest of the line verbatim.
 *
 * Real skills in the wild write `description: Use this. Triggers on: foo` —
 * an unquoted scalar with a colon in it, which is not YAML at all. Their
 * authors never ran a parser over it, and a skill losing its description
 * (the only thing the model picks it by) is a worse outcome than accepting
 * a line-oriented reading. Structured values are NOT recovered here: a skill
 * that declares `scripts:` has to be valid YAML.
 */
function looseFrontmatter(header: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const lines = header.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (['>', '>-', '|', '|-'].includes(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) {
        block.push(lines[++i].trim());
      }
      value = block.join(' ').trim();
    }
    attrs[m[1]] = value.replace(/^["']|["']$/g, '');
  }
  return attrs;
}

/** Files already reported as non-YAML — the registry reloads every turn. */
const looseReported = new Set<string>();

/**
 * YAML frontmatter of a SKILL.md. Real YAML, because skills declare
 * structured values (a `scripts:` list of objects) that no hand-rolled
 * key:value reader can carry — with a lenient fallback, because a vendored
 * skill's header is not ours to fix.
 */
export function parseFrontmatter(
  md: string,
  source = '(inline)',
): { attrs: Record<string, unknown>; body: string } {
  if (!md.startsWith('---\n')) return { attrs: {}, body: md };
  const end = md.indexOf('\n---', 4);
  if (end < 0) return { attrs: {}, body: md };
  const header = md.slice(4, end);
  const body = md.slice(end + 4).replace(/^-*\n?/, '').trim();
  try {
    const parsed: unknown = parseYaml(header);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { attrs: parsed as Record<string, unknown>, body };
    }
    return { attrs: {}, body };
  } catch (err) {
    if (!looseReported.has(source)) {
      looseReported.add(source);
      console.warn(
        `[plugins] ${source}: frontmatter is not valid YAML (${(err as Error).message.split('\n')[0]}) — read leniently; \`scripts:\` needs valid YAML`,
      );
    }
    return { attrs: looseFrontmatter(header), body };
  }
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
    const { attrs, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'), file);
    const dir = path.join(skillsDir, entry.name);
    const name = str(attrs.name) || entry.name;
    skills.push({
      plugin,
      name,
      description: str(attrs.description),
      body,
      dir,
      scripts: resolveSkillScripts({ plugin, name, dir, body, declared: attrs.scripts }),
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

/**
 * Admin-global skills: ${VAR_DIR}/skills/<name>/SKILL.md — dropped on the
 * data volume next to mcp.json. Read fresh every call, so admins can add or
 * edit skills without a restart (mirrors how the MCP config is picked up).
 */
export function loadAdminSkills(): PluginSkill[] {
  try {
    return skillsFromDir('admin', path.join(path.resolve(env().VAR_DIR), 'skills'));
  } catch {
    // unconfigured env (e.g. astro build) — no admin skills
    return [];
  }
}

/**
 * Admin-global rules: ${VAR_DIR}/rules/*.md — always-on prompt rules from
 * the data volume, read fresh like the admin skills.
 */
export function loadAdminRules(): PluginRule[] {
  try {
    const dir = path.join(path.resolve(env().VAR_DIR), 'rules');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => ({ plugin: 'admin', text: fs.readFileSync(path.join(dir, f), 'utf8').trim() }));
  } catch {
    // unconfigured env (e.g. astro build) — no admin rules
    return [];
  }
}

/** Global and site-repository AGENTS.md files, read fresh for every turn. */
export function loadAgentsRules(worktreePath?: string): PluginRule[] {
  const rules: PluginRule[] = [];
  try {
    const globalFile = path.join(path.resolve(env().VAR_DIR), 'AGENTS.md');
    if (fs.existsSync(globalFile)) {
      rules.push({ plugin: 'global', text: fs.readFileSync(globalFile, 'utf8').trim() });
    }
  } catch {
    // unconfigured env (e.g. astro build) — no global rule
  }
  if (worktreePath) {
    const repoFile = path.join(worktreePath, 'AGENTS.md');
    if (fs.existsSync(repoFile)) {
      rules.push({ plugin: 'site repo', text: fs.readFileSync(repoFile, 'utf8').trim() });
    }
  }
  return rules;
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

/** All skills visible to a chat, in shadowing order: branch-local first
 *  (they win name clashes), then admin (VAR_DIR/skills), then plugins. */
export function skillsForChat(worktreePath?: string): PluginSkill[] {
  const branch = loadBranchSkills(worktreePath);
  const taken = new Set(branch.map((s) => s.name.toLowerCase()));
  const admin = loadAdminSkills().filter((s) => !taken.has(s.name.toLowerCase()));
  for (const s of admin) taken.add(s.name.toLowerCase());
  return [
    ...branch,
    ...admin,
    ...loadPluginRegistry().skills.filter((s) => !taken.has(s.name.toLowerCase())),
  ];
}

/**
 * System-prompt section: always-on rules (plugins + VAR_DIR/rules) and the
 * on-demand skill list.
 *
 * The skill list is the router's selection (lib/agent/skillRouter), not the
 * whole install — listing every skill in every prompt is what this costs
 * tokens for. `routedSkills` undefined means no routing happened (a caller
 * outside a turn, e.g. a test); then the full list is shown as before.
 */
export function pluginPromptSection(worktreePath?: string, routedSkills?: string[]): string {
  const rules = [
    ...loadPluginRegistry().rules,
    ...loadAdminRules(),
    ...loadAgentsRules(worktreePath),
  ];
  const all = skillsForChat(worktreePath);
  const routed = routedSkills && new Set(routedSkills.map((s) => s.toLowerCase()));
  const skills = routed ? all.filter((s) => routed.has(s.name.toLowerCase())) : all;
  const parts: string[] = [];
  if (rules.length > 0) {
    parts.push(
      'Plugin rules — these ALWAYS apply to your work:\n\n' +
        rules.map((r) => `[${r.plugin}]\n${r.text}`).join('\n\n'),
    );
  }
  // With routing on, the pointer must be there even when nothing was selected:
  // an empty section would read as "this install has no skills".
  const more =
    routed && all.length > skills.length
      ? `\nThe other ${all.length - skills.length} installed skill(s) are not listed here — ` +
        'call query_skills with a keyword to search them.'
      : '';
  if (skills.length === 0 && routed && all.length > 0) {
    parts.push(
      `No skill was selected for this turn. ${all.length} are installed — call query_skills ` +
        'with a keyword to search them, then use_skill to load one.',
    );
  } else if (skills.length > 0) {
    parts.push(
      'Available skills — call use_skill with a name to load its full instructions ' +
        'when the task (or the user) calls for it:\n' +
        skills
          .map((s) => {
            const origin =
              s.plugin === 'site repo'
                ? ' (from the site repo)'
                : s.plugin === 'admin'
                  ? ' (admin-provided)'
                  : '';
            // Scripts are listed with the skill so run_skill_script has
            // something to name; what they expect is in the skill body.
            const scripts = s.scripts
              .map((sc) => `\n    · script "${sc.id}": ${sc.description}`)
              .join('');
            return `- ${s.name}${origin}: ${s.description.slice(0, 300)}${scripts}`;
          })
          .join('\n') +
        more,
    );
  }
  return parts.join('\n\n');
}
