/**
 * Executable scripts carried by a skill.
 *
 * A skill declares them in its SKILL.md frontmatter:
 *
 *   scripts:
 *     - id: links
 *       run: node scripts/links.mjs
 *       description: Report broken internal links
 *     - id: fix
 *       run: node scripts/fix-links.mjs
 *       description: Rewrite them to the right target
 *       flags: [write]
 *
 * Third-party skills predate this and declare their scripts the only way the
 * format allowed — in prose ("run `python3 scripts/analyze.py`"). Those are
 * DERIVED from the body, and a derived script never carries a flag: prose is
 * evidence that something is runnable, never that it may write, reach the
 * network, or run while planning. The same rule the MCP policy applies to
 * undeclared tools — trust what is declared, default the rest to restrictive.
 *
 * An admin overlay (${VAR_DIR}/skill-scripts.json, next to mcp.json) is the
 * escape hatch when derivation gets a vendored skill wrong, and the only way
 * a third-party skill gains a flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';

/** Interpreters the sandbox env actually ships (flake.nix sandboxCommonPkgs). */
const INTERPRETERS = new Set(['node', 'sh', 'bash', 'python3', 'python']);

/** A doc-heavy skill must not flood the prompt with derived candidates. */
const MAX_DERIVED = 8;

export interface SkillScriptFlags {
  /** Bind /work writable. Without it the worktree is read-only. */
  write?: boolean;
  /** Allow network. Off by default, unlike run_command. */
  network?: boolean;
  /** Callable while planning. Refused together with `write`. */
  plan?: boolean;
}

export interface SkillScript {
  id: string;
  /** [interpreter, scriptPath, ...fixed args] — paths relative to the skill dir. */
  argv: string[];
  description: string;
  flags: SkillScriptFlags;
  /** Absolute host path of the script file. */
  file: string;
  origin: 'declared' | 'derived' | 'overlay';
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/** Resolve a declared path inside the skill dir; null when it escapes or is absent. */
function scriptFile(skillDir: string, rel: string): string | null {
  const abs = path.resolve(skillDir, rel);
  if (abs !== skillDir && !abs.startsWith(skillDir + path.sep)) return null;
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

const flagsFrom = (raw: unknown): SkillScriptFlags => {
  const list = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
  const flags: SkillScriptFlags = {};
  if (list.includes('write')) flags.write = true;
  if (list.includes('network')) flags.network = true;
  // A script that writes is not a planning tool, whatever it claims.
  if (list.includes('plan') && !flags.write) flags.plan = true;
  return flags;
};

/**
 * Build one script from an authored entry ({id, run, description, flags}).
 * Returns null with a warning for anything malformed — a broken entry must
 * not take the whole skill down.
 */
function scriptFromEntry(
  skillDir: string,
  raw: unknown,
  origin: 'declared' | 'overlay',
  label: string,
): SkillScript | null {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const run = typeof entry.run === 'string' ? entry.run.trim() : '';
  const description = typeof entry.description === 'string' ? entry.description.trim() : '';
  const warn = (why: string): null => {
    console.warn(`[skills] ${label}: script ${id || '(unnamed)'} ${why} — skipped`);
    return null;
  };
  if (!KEBAB.test(id)) return warn('needs a kebab-case id');
  if (!run) return warn('has no run command');
  if (!description) return warn('has no description (it is what the model picks it by)');

  const argv = run.split(/\s+/);
  if (!INTERPRETERS.has(argv[0])) {
    return warn(`runs "${argv[0]}", which the sandbox has no interpreter for (${[...INTERPRETERS].join(', ')})`);
  }
  const file = argv[1] ? scriptFile(skillDir, argv[1]) : null;
  if (!file) return warn(`points at ${argv[1] ?? '(nothing)'}, which is not a file inside the skill`);

  return { id, argv, description, flags: flagsFrom(entry.flags), file, origin };
}

export function parseDeclaredScripts(skillDir: string, raw: unknown, label: string): SkillScript[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillScript[] = [];
  for (const entry of raw) {
    const script = scriptFromEntry(skillDir, entry, 'declared', label);
    if (script && !out.some((s) => s.id === script.id)) out.push(script);
  }
  return out;
}

// ── Derivation from prose ───────────────────────────────────────────────────

const RUNNABLE = /(?:(node|python3?|bash|sh)\s+)?((?:\.\/)?[\w./-]*scripts\/[\w.-]+\.(sh|mjs|cjs|js|py))/g;
const BY_EXT: Record<string, string> = {
  sh: 'sh',
  mjs: 'node',
  cjs: 'node',
  js: 'node',
  py: 'python3',
};

/**
 * Scripts a skill mentions in its body. Only the interpreter and the path are
 * taken — arguments shown in an example line are guesses, and the model has
 * the full body from use_skill to pass its own.
 */
export function deriveScripts(skillDir: string, body: string): SkillScript[] {
  const out: SkillScript[] = [];
  for (const line of body.split('\n')) {
    for (const [, interpreter, rel, ext] of line.matchAll(RUNNABLE)) {
      const file = scriptFile(skillDir, rel);
      if (!file) continue;
      const id = path.basename(rel, path.extname(rel)).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      if (!KEBAB.test(id) || out.some((s) => s.id === id)) continue;
      out.push({
        id,
        argv: [interpreter ?? BY_EXT[ext], rel],
        description: line.trim().replace(/\s+/g, ' ').slice(0, 120),
        flags: {}, // never widened from prose
        file,
        origin: 'derived',
      });
      if (out.length >= MAX_DERIVED) return out;
    }
  }
  return out;
}

// ── Admin overlay ───────────────────────────────────────────────────────────

interface OverlayEntry {
  scripts?: unknown[];
}

/** ${VAR_DIR}/skill-scripts.json, read fresh like mcp.json and the admin skills. */
export function loadScriptOverlay(): Record<string, OverlayEntry> {
  try {
    const file = path.join(path.resolve(env().VAR_DIR), 'skill-scripts.json');
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, OverlayEntry>)
      : {};
  } catch (err) {
    console.warn(`[skills] skill-scripts.json is unreadable — ignored: ${(err as Error).message}`);
    return {};
  }
}

/**
 * The scripts of one skill: an admin overlay wins, then what the skill
 * declares, then what its prose gives away.
 */
export function resolveSkillScripts(skill: {
  plugin: string;
  name: string;
  dir: string;
  body: string;
  declared: unknown;
}): SkillScript[] {
  const label = `${skill.plugin}/${skill.name}`;
  const overlay = loadScriptOverlay()[label];
  if (overlay) {
    const scripts: SkillScript[] = [];
    for (const entry of Array.isArray(overlay.scripts) ? overlay.scripts : []) {
      const script = scriptFromEntry(skill.dir, entry, 'overlay', `overlay ${label}`);
      if (script && !scripts.some((s) => s.id === script.id)) scripts.push(script);
    }
    return scripts;
  }
  const declared = parseDeclaredScripts(skill.dir, skill.declared, label);
  return declared.length > 0 ? declared : deriveScripts(skill.dir, skill.body);
}
