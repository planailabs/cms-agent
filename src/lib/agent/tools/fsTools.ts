/**
 * Repo tools — read tools for all phases; write tools work on the site only
 * in EXECUTE, but on the git-excluded .scratch/ area in every phase.
 * Every path is jailed to the chat's branch worktree; symlink escapes are
 * rejected via realpath containment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  assertSafeRef,
  branchDiff,
  branchLog,
  defaultBranch,
  listRepoBranches,
  showCommit,
  worktreeStatus,
} from '@/lib/git/engine';
import { findPausedAutomatism } from '@/lib/automatism';
import { imageMimeForPath } from '../messageUtils';
import { registerTool, type ToolContext, type ToolDef } from './registry';
import { activeBackend } from '@/lib/site';
import { ALL_PHASES } from '../types';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro']);
const MAX_FILE_CHARS = 50_000;
const MAX_RESULTS = 200;

/**
 * The scratch area: a git-excluded directory at the repo root, writable in
 * every phase. Never committed or published; part of the regular file tree.
 */
export const SCRATCH_DIR = '.scratch';

/** True when a repo-relative path points into the scratch area. */
export function isScratchPath(p: string): boolean {
  // jail() independently guarantees worktree containment; normalize resolves
  // "foo/../.scratch/x" → ".scratch/x" and ".scratch/../src/x" → "src/x".
  const norm = path.posix.normalize(p.replaceAll('\\', '/'));
  return norm === SCRATCH_DIR || norm.startsWith(`${SCRATCH_DIR}/`);
}

/**
 * A deployment chat exists to unblock one publish, not to edit the site: it
 * runs with EXECUTE tools on the source chat's worktree, so without this the
 * agent could take "and make the hero blue" as work to do — on a branch whose
 * review is already over, in a chat nobody publishes from.
 */
export const DEPLOY_WRITE_REFUSAL =
  'This is a deployment chat: it may only fix the deploy that is currently paused, and nothing ' +
  'is paused. Page and content changes belong in the editorial chat for this branch — tell the ' +
  'user to make the change there and publish again.';

/**
 * Writes outside EXECUTE are restricted to the scratch area, and a deployment
 * chat may touch the site only while its own deploy is paused on a failure.
 */
export async function assertWritable(ctx: ToolContext, ...paths: string[]): Promise<void> {
  const scratchOnly = paths.every(isScratchPath);
  // .scratch/ is never committed or published, so notes and research stay free.
  if (ctx.chatKind === 'deployment' && !scratchOnly && !(await findPausedAutomatism(ctx.chatId))) {
    throw new Error(DEPLOY_WRITE_REFUSAL);
  }
  if (ctx.workflowPhase === 'execute') return;
  if (scratchOnly) return;
  throw new Error('Only .scratch/ is writable outside the execute phase');
}

/** Resolve p inside the worktree; throws on escape (including via symlink). */
export function jail(ctx: ToolContext, p: string): string {
  const root = fs.realpathSync(ctx.worktreePath);
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the repository: ${p}`);
  }
  // realpath containment for the deepest existing ancestor (symlink escape)
  let probe = resolved;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the repository via symlink: ${p}`);
  }
  return resolved;
}

function* walk(dir: string, root: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name), root);
    } else if (entry.isFile()) {
      yield path.relative(root, path.join(dir, entry.name));
    }
  }
}

// Deployment chats work on the source chat's work worktree (conflict fixes)
const REPO_KINDS = ['workflow', 'deployment'] as const;

const readFileTool: ToolDef = {
  name: 'read_file',
  description: 'Read a file from the site repository. Paths are relative to the repo root.',
  schema: z.object({ path: z.string() }),
  phases: ALL_PHASES,
  kinds: [...REPO_KINDS],
  async execute(input, ctx) {
    const p = jail(ctx, input.path);
    const buf = fs.readFileSync(p);
    // Binaries are not text — raw NUL bytes would also kill the Postgres
    // message insert. Repo images still reach the model: the loop pairs this
    // marker with an inlined multimodal message (see toOpenAiMessages).
    if (buf.includes(0)) {
      return imageMimeForPath(input.path)
        ? `[image file: ${input.path}, ${buf.length} bytes — attached to the conversation below]`
        : `[binary file: ${input.path}, ${buf.length} bytes — not readable as text]`;
    }
    const content = buf.toString('utf8');
    return content.length > MAX_FILE_CHARS
      ? content.slice(0, MAX_FILE_CHARS) + `\n… (truncated, ${content.length} chars total)`
      : content;
  },
};

const listDirTool: ToolDef = {
  name: 'list_dir',
  description: 'List a directory in the site repository (non-recursive). "." for the root.',
  schema: z.object({ path: z.string().default('.') }),
  phases: ALL_PHASES,
  kinds: [...REPO_KINDS],
  async execute(input, ctx) {
    const p = jail(ctx, input.path);
    const entries = fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name))
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
      .sort();
    return entries.join('\n') || '(empty)';
  },
};

const grepTool: ToolDef = {
  name: 'grep',
  description:
    'Search file contents in the repository with a regular expression. Returns "path:line: text" matches.',
  schema: z.object({
    pattern: z.string().describe('JavaScript regular expression'),
    glob: z.string().optional().describe('Only search files whose path contains this substring'),
  }),
  phases: ALL_PHASES,
  kinds: [...REPO_KINDS],
  async execute(input, ctx) {
    const root = jail(ctx, '.');
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (e) {
      return JSON.stringify({ error: `Invalid pattern: ${e instanceof Error ? e.message : e}` });
    }
    const matches: string[] = [];
    for (const rel of walk(root, root)) {
      if (input.glob && !rel.includes(input.glob)) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue; // binary
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= MAX_RESULTS) {
            matches.push(`… (stopped at ${MAX_RESULTS} matches)`);
            return matches.join('\n');
          }
        }
      }
    }
    return matches.join('\n') || 'No matches.';
  },
};

const listPagesTool: ToolDef = {
  name: 'list_pages',
  description: 'List all page and content files of the site.',
  schema: z.object({}),
  phases: ALL_PHASES,
  async execute(_input, ctx) {
    const root = jail(ctx, '.');
    const backend = activeBackend();
    const files = [...walk(root, root)].filter(
      (f) => backend.isSiteContent(f) && !isScratchPath(f),
    );
    return files.join('\n') || '(no pages found)';
  },
};

// Read-only git tools: also in deployment chats + the deployments system chat.
const GIT_KINDS = ['workflow', 'deployment', 'deployments'] as const;

const gitLogTool: ToolDef = {
  name: 'git_log',
  description:
    'Show commit history. Defaults to the current draft branch; pass ref for another branch/sha.',
  schema: z.object({
    maxCount: z.number().int().positive().max(100).default(20),
    ref: z.string().optional().describe('Branch, tag, or sha (default: current branch)'),
  }),
  phases: ALL_PHASES,
  kinds: [...GIT_KINDS],
  async execute(input, ctx) {
    if (input.ref) assertSafeRef(input.ref);
    const log = await branchLog(input.ref ?? ctx.branchName, input.maxCount);
    return log.map((c) => `${c.sha.slice(0, 8)} ${c.date} ${c.authorName}: ${c.message}`).join('\n');
  },
};

const gitShowTool: ToolDef = {
  name: 'git_show',
  description: 'Show one commit: message, changed files, and full patch.',
  schema: z.object({ ref: z.string().describe('Commit sha, branch, or tag') }),
  phases: ALL_PHASES,
  kinds: [...GIT_KINDS],
  async execute(input) {
    const out = await showCommit(input.ref);
    return out.length > MAX_FILE_CHARS
      ? out.slice(0, MAX_FILE_CHARS) + `\n… (truncated, ${out.length} chars total)`
      : out;
  },
};

const gitDiffTool: ToolDef = {
  name: 'git_diff',
  description:
    'Show the committed diff of a branch against a base (defaults: draft branch vs main).',
  schema: z.object({
    ref: z.string().optional().describe('Branch to diff (default: current branch)'),
    base: z.string().optional().describe('Base to diff against (default: main)'),
  }),
  phases: ALL_PHASES,
  kinds: [...GIT_KINDS],
  async execute(input, ctx) {
    if (input.ref) assertSafeRef(input.ref);
    if (input.base) assertSafeRef(input.base);
    const diff = await branchDiff(input.ref ?? ctx.branchName, input.base);
    return diff.slice(0, MAX_FILE_CHARS) || '(no committed changes against the base)';
  },
};

const gitStatusTool: ToolDef = {
  name: 'git_status',
  description: 'Show uncommitted changes in the current branch worktree.',
  schema: z.object({}),
  phases: ALL_PHASES,
  kinds: [...GIT_KINDS],
  async execute(_input, ctx) {
    const lines = await worktreeStatus(ctx.branchName);
    return lines.join('\n') || '(worktree clean)';
  },
};

const gitBranchesTool: ToolDef = {
  name: 'git_branches',
  description: 'List the branches of the site repository (default branch marked).',
  schema: z.object({}),
  phases: ALL_PHASES,
  kinds: [...GIT_KINDS],
  async execute() {
    const [branches, def] = await Promise.all([listRepoBranches(), defaultBranch()]);
    return branches.map((b) => (b === def ? `* ${b} (default)` : `  ${b}`)).join('\n');
  },
};

// ─── Write tools (site in EXECUTE only; .scratch/ in every phase) ────────────

const writeFileTool: ToolDef = {
  name: 'write_file',
  description:
    'Create or overwrite a file in the repository. Outside the EXECUTE phase only paths under .scratch/ (the uncommitted scratch area) are writable.',
  schema: z.object({ path: z.string(), content: z.string() }),
  phases: ALL_PHASES,
  kinds: [...REPO_KINDS],
  async execute(input, ctx) {
    await assertWritable(ctx, input.path);
    const p = jail(ctx, input.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, input.content);
    if (!isScratchPath(input.path)) ctx.modifiedPaths.add(input.path);
    return JSON.stringify({ success: true, path: input.path });
  },
};

const editFileTool: ToolDef = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. oldText must occur exactly once unless replaceAll is true.',
  schema: z.object({
    path: z.string(),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
  }),
  phases: ALL_PHASES,
  kinds: [...REPO_KINDS],
  async execute(input, ctx) {
    await assertWritable(ctx, input.path);
    const p = jail(ctx, input.path);
    const content = fs.readFileSync(p, 'utf8');
    const occurrences = content.split(input.oldText).length - 1;
    if (occurrences === 0) return JSON.stringify({ error: 'oldText not found in file' });
    if (occurrences > 1 && !input.replaceAll) {
      return JSON.stringify({
        error: `oldText occurs ${occurrences} times — provide more context or set replaceAll`,
      });
    }
    fs.writeFileSync(
      p,
      input.replaceAll
        ? content.split(input.oldText).join(input.newText)
        : content.replace(input.oldText, input.newText),
    );
    if (!isScratchPath(input.path)) ctx.modifiedPaths.add(input.path);
    return JSON.stringify({ success: true, path: input.path });
  },
};

const removeFileTool: ToolDef = {
  name: 'remove_file',
  description: 'Remove a file or, when recursive is true, a directory from the repository.',
  schema: z.object({
    path: z.string(),
    recursive: z.boolean().default(false).describe('Required to remove directories and their contents'),
  }),
  phases: ALL_PHASES,
  kinds: [...REPO_KINDS],
  async execute(input, ctx) {
    await assertWritable(ctx, input.path);
    const p = jail(ctx, input.path);
    if (p === fs.realpathSync(ctx.worktreePath)) {
      return JSON.stringify({ error: 'Cannot remove the repository root' });
    }
    fs.rmSync(p, { recursive: input.recursive });
    if (!isScratchPath(input.path)) ctx.modifiedPaths.add(input.path);
    return JSON.stringify({ success: true, removed: input.path });
  },
};

const moveFileTool: ToolDef = {
  name: 'move_file',
  description:
    'Move or rename a file or directory within the repository — binary-safe. Use it to promote finished .scratch/ artifacts (screenshots, downloads, drafts) into the site during EXECUTE. Outside the EXECUTE phase both source and destination must be under .scratch/.',
  schema: z.object({ from: z.string(), to: z.string() }),
  phases: ALL_PHASES,
  kinds: [...REPO_KINDS],
  async execute(input, ctx) {
    // Gate the source too: moving a repo file during plan mutates the repo.
    await assertWritable(ctx, input.from, input.to);
    const src = jail(ctx, input.from);
    const dst = jail(ctx, input.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst); // same filesystem (one worktree) — no EXDEV
    if (!isScratchPath(input.from)) ctx.modifiedPaths.add(input.from);
    if (!isScratchPath(input.to)) ctx.modifiedPaths.add(input.to);
    return JSON.stringify({ success: true, from: input.from, to: input.to });
  },
};

const getUserContextTool: ToolDef = {
  name: 'get_user_context',
  description:
    'Get the live user context: which preview page each connected editor is viewing, recent selections, and files modified in this chat.',
  schema: z.object({}),
  phases: ALL_PHASES,
  async execute(_input, ctx) {
    return JSON.stringify({
      editors: Object.fromEntries(ctx.userContext),
      modifiedInThisChat: [...ctx.modifiedPaths],
      branch: ctx.branchName,
    });
  },
};

export function registerFsTools(): void {
  registerTool(readFileTool);
  registerTool(listDirTool);
  registerTool(grepTool);
  registerTool(listPagesTool);
  registerTool(gitLogTool);
  registerTool(gitShowTool);
  registerTool(gitDiffTool);
  registerTool(gitStatusTool);
  registerTool(gitBranchesTool);
  registerTool(writeFileTool);
  registerTool(editFileTool);
  registerTool(removeFileTool);
  registerTool(moveFileTool);
  registerTool(getUserContextTool);
}
