/**
 * Merge-conflict helpers — locate conflicts in the worktree, inspect their
 * hunks, take one side wholesale, and read files from the target branch.
 * Available in deployment chats (which operate on the source chat's work
 * worktree) and in workflow chats during EXECUTE.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { simpleGit } from 'simple-git';
import {
  abortRebase,
  continueRebase,
  rebaseInProgress,
  rebaseOnto,
  showFileAtRef,
  type RebaseResult,
} from '@/lib/git/engine';
import { chatGitIdentity } from '@/lib/git/identity';
import { withBranchLock } from '../bus';
import { jail } from './fsTools';
import { registerTool, type ToolDef } from './registry';

const KINDS = ['workflow', 'deployment'] as const;
const MAX_CHARS = 50_000;

const listConflictsTool: ToolDef = {
  name: 'list_conflicts',
  description:
    'List the merge-conflicted files in the worktree and whether a merge is in progress. ' +
    'Start here when resolving conflicts.',
  schema: z.object({}),
  phases: ['execute'],
  kinds: [...KINDS],
  async execute(_input, ctx) {
    const git = simpleGit(ctx.worktreePath);
    const status = await git.status();
    const merging = await git
      .raw(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);
    const rebasing = await rebaseInProgress(ctx.worktreePath);
    return JSON.stringify({
      mergeInProgress: merging,
      rebaseInProgress: rebasing,
      conflicted: status.conflicted,
      note: status.conflicted.length
        ? `Use show_conflict per file, resolve the markers (edit_file or resolve_conflict_take), then ${
            rebasing ? 'git_rebase_continue' : 'git_commit to conclude the merge'
          }.`
        : 'No conflicted files.',
    });
  },
};

const showConflictTool: ToolDef = {
  name: 'show_conflict',
  description:
    'Show the conflict hunks of one file: each <<<<<<< / ======= / >>>>>>> block with its ' +
    'line numbers, ours (worktree branch) and theirs (incoming) sides.',
  schema: z.object({ path: z.string() }),
  phases: ['execute'],
  kinds: [...KINDS],
  async execute(input, ctx) {
    const p = jail(ctx, input.path);
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const hunks: Array<Record<string, unknown>> = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('<<<<<<<')) continue;
      const start = i;
      const ours: string[] = [];
      const theirs: string[] = [];
      let side = ours;
      for (i++; i < lines.length && !lines[i].startsWith('>>>>>>>'); i++) {
        if (lines[i].startsWith('=======')) side = theirs;
        else side.push(lines[i]);
      }
      hunks.push({
        lines: `${start + 1}-${i + 1}`,
        ours: ours.join('\n').slice(0, 4000),
        theirs: theirs.join('\n').slice(0, 4000),
      });
    }
    return JSON.stringify(
      hunks.length ? { path: input.path, hunks } : { path: input.path, note: 'No conflict markers in this file.' },
    );
  },
};

const resolveTakeTool: ToolDef = {
  name: 'resolve_conflict_take',
  description:
    'Resolve one conflicted file by taking a whole side: "ours" (the worktree branch) or ' +
    '"theirs" (the incoming branch). For mixed resolutions edit the markers with edit_file instead.',
  schema: z.object({
    path: z.string(),
    side: z.enum(['ours', 'theirs']),
  }),
  phases: ['execute'],
  kinds: [...KINDS],
  async execute(input, ctx) {
    jail(ctx, input.path); // path containment; git gets the relative path
    const git = simpleGit(ctx.worktreePath);
    await git.raw(['checkout', `--${input.side}`, '--', input.path]);
    await git.raw(['add', '--', input.path]);
    ctx.modifiedPaths.add(input.path);
    return JSON.stringify({ resolved: input.path, took: input.side });
  },
};

const targetFileTool: ToolDef = {
  name: 'target_file',
  description:
    "Read a file as it exists on the TARGET branch (the branch this chat's work merges " +
    'into) — useful to understand the incoming side of a conflict. Pass ref to read from ' +
    'another branch/sha instead.',
  schema: z.object({
    path: z.string(),
    ref: z.string().optional().describe('Branch/sha (default: the target branch)'),
  }),
  phases: ['plan', 'execute', 'preview', 'published'],
  kinds: [...KINDS],
  async execute(input, ctx) {
    const ref = input.ref ?? ctx.targetBranchName;
    if (!ref) return JSON.stringify({ error: 'No target branch known for this chat.' });
    try {
      const content = await showFileAtRef(ref, input.path);
      return content.length > MAX_CHARS
        ? content.slice(0, MAX_CHARS) + `\n… (truncated, ${content.length} chars total)`
        : content;
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};

const rebaseResult = (r: RebaseResult): string =>
  JSON.stringify(
    r.conflicts?.length
      ? {
          conflicts: r.conflicts,
          note: 'Rebase paused on conflicts — resolve them (show_conflict / edit_file / resolve_conflict_take), then git_rebase_continue.',
        }
      : { ok: true, sha: r.sha },
  );

const gitRebaseTool: ToolDef = {
  name: 'git_rebase',
  description:
    'Rebase the work branch onto a base (default: the target branch) — replays this ' +
    "chat's commits on top of it. REWRITES the branch history (a previously reviewed " +
    'sha changes, so the preview must be reviewed again). On conflicts the rebase ' +
    'pauses with markers in the files; resolve and git_rebase_continue.',
  schema: z.object({
    base: z.string().optional().describe('Base branch/sha (default: the target branch)'),
  }),
  phases: ['execute'],
  kinds: [...KINDS],
  async execute(input, ctx) {
    const base = input.base ?? ctx.targetBranchName;
    if (!base) return JSON.stringify({ error: 'No target branch known — pass base explicitly.' });
    const identity = await chatGitIdentity(ctx.chatId, ctx.userId);
    const r = await withBranchLock(ctx.branchName, () => rebaseOnto(ctx.branchName, base, identity));
    return rebaseResult(r);
  },
};

const gitRebaseContinueTool: ToolDef = {
  name: 'git_rebase_continue',
  description:
    'Continue a paused rebase after resolving its conflicts (stages everything first). ' +
    'Returns the next conflict batch, or the new head when the rebase completes.',
  schema: z.object({}),
  phases: ['execute'],
  kinds: [...KINDS],
  async execute(_input, ctx) {
    const identity = await chatGitIdentity(ctx.chatId, ctx.userId);
    const r = await withBranchLock(ctx.branchName, () => continueRebase(ctx.branchName, identity));
    return rebaseResult(r);
  },
};

const gitRebaseAbortTool: ToolDef = {
  name: 'git_rebase_abort',
  description: 'Abort an in-progress rebase and restore the branch to its pre-rebase state.',
  schema: z.object({}),
  phases: ['execute'],
  kinds: [...KINDS],
  async execute(_input, ctx) {
    await withBranchLock(ctx.branchName, () => abortRebase(ctx.branchName));
    return JSON.stringify({ ok: true, note: 'Rebase aborted (no-op if none was in progress).' });
  },
};

export function registerConflictTools(): void {
  registerTool(listConflictsTool);
  registerTool(showConflictTool);
  registerTool(resolveTakeTool);
  registerTool(targetFileTool);
  registerTool(gitRebaseTool);
  registerTool(gitRebaseContinueTool);
  registerTool(gitRebaseAbortTool);
}
