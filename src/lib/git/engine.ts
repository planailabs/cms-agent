/**
 * Git engine — branches, worktrees, single-commit executions, revert/undo,
 * merge to main, changed files. One managed repo (REPO_PATH), worktrees under
 * VAR_DIR/worktrees/<branch>. All mutating callers must hold the branch
 * mutation lock (bus.withBranchLock).
 */
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { env } from '@/lib/env';

const RESERVED_BRANCH_NAMES = new Set(['main', 'master', 'www', 'api', 'cms', 'mail', 'ns1', 'ns2']);
const BRANCH_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** DNS-safe label usable as subdomain AND git branch (plan §5). */
export function validateBranchName(name: string): string | null {
  if (!BRANCH_RE.test(name)) {
    return 'Branch names must be DNS-safe labels: lowercase letters, digits, hyphens (1–63 chars, no leading/trailing hyphen).';
  }
  if (RESERVED_BRANCH_NAMES.has(name) || name.startsWith('v-')) {
    return `"${name}" is reserved.`;
  }
  return null;
}

function repoGit(): SimpleGit {
  const repoPath = path.resolve(env().REPO_PATH);
  // Refuse to operate on a REPO_PATH that isn't its own repository — git
  // would silently walk up to a parent repo (e.g. the CMS checkout when
  // pointing at examples/ in-tree). scripts/setup-dev-site.sh creates a
  // proper copy.
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(
      `REPO_PATH (${repoPath}) is not a git repository. Use scripts/setup-dev-site.sh to create a git-inited working copy.`,
    );
  }
  return simpleGit(repoPath);
}

export function worktreeDir(branch: string): string {
  return path.join(path.resolve(env().VAR_DIR), 'worktrees', branch);
}

export async function defaultBranch(): Promise<string> {
  const git = repoGit();
  const branches = await git.branchLocal();
  if (branches.all.includes('main')) return 'main';
  if (branches.all.includes('master')) return 'master';
  return branches.current;
}

/** Create the git branch (from main) if missing. */
export async function ensureBranch(branch: string): Promise<void> {
  const git = repoGit();
  const branches = await git.branchLocal();
  if (!branches.all.includes(branch)) {
    await git.branch([branch, await defaultBranch()]);
  }
}

/** Historical read-only checkouts use the reserved v-<sha> label (plan §12). */
export function historicalRef(name: string): string | null {
  const m = /^v-([0-9a-f]{7,40})$/.exec(name);
  return m ? m[1] : null;
}

/**
 * Ensure a worktree exists for the branch and return its absolute path.
 * For the default branch, the repo itself is the worktree. `v-<sha>` names
 * produce detached read-only checkouts of that commit (historical preview).
 */
export async function ensureWorktree(branch: string): Promise<string> {
  const repoPath = path.resolve(env().REPO_PATH);
  if (branch === (await defaultBranch())) return repoPath;

  const dir = worktreeDir(branch);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // Prune stale registrations (e.g. VAR_DIR wiped) before adding
  await repoGit().raw(['worktree', 'prune']);

  const sha = historicalRef(branch);
  if (sha) {
    await repoGit().raw(['worktree', 'add', '--detach', dir, sha]);
  } else {
    await ensureBranch(branch);
    await repoGit().raw(['worktree', 'add', dir, branch]);
  }
  return dir;
}

export async function removeWorktree(branch: string): Promise<void> {
  const dir = worktreeDir(branch);
  if (fs.existsSync(dir)) {
    await repoGit().raw(['worktree', 'remove', '--force', dir]);
  }
  await repoGit().raw(['worktree', 'prune']);
}

/** HEAD sha of a branch. */
export async function branchSha(branch: string): Promise<string> {
  return (await repoGit().revparse([branch])).trim();
}

/**
 * Stage and commit ALL worktree changes as one self-contained commit
 * (plan §3: one commit per execution). Returns the sha, or null when the
 * worktree is clean (empty execution).
 */
export async function commitExecution(
  branch: string,
  message: string,
  author: { name: string; email: string },
): Promise<string | null> {
  const dir = await ensureWorktree(branch);
  const git = simpleGit(dir);
  const status = await git.status();
  if (status.isClean()) return null;
  await git.add(['-A']);
  await git.commit(message, undefined, {
    '--author': `${author.name} <${author.email}>`,
  });
  return (await git.revparse(['HEAD'])).trim();
}

/** Working-tree status of a branch worktree (dirty file list). */
export async function worktreeStatus(branch: string): Promise<string[]> {
  const dir = await ensureWorktree(branch);
  const status = await simpleGit(dir).status();
  return status.files.map((f) => f.path);
}

/** Revert a commit on the branch (new revert commit; never destructive). */
export async function revertCommit(branch: string, sha: string): Promise<string> {
  const dir = await ensureWorktree(branch);
  const git = simpleGit(dir);
  await git.raw(['revert', '--no-edit', sha]);
  return (await git.revparse(['HEAD'])).trim();
}

/** Merge the branch into main with a merge commit; returns main's new sha. */
export async function mergeToMain(branch: string): Promise<string> {
  const main = await defaultBranch();
  const git = repoGit();
  const current = (await git.branchLocal()).current;
  if (current !== main) await git.checkout(main);
  await git.merge(['--no-ff', '-m', `Publish ${branch}`, branch]);
  return (await git.revparse(['HEAD'])).trim();
}

/** Reset a branch (and its worktree) onto main after publish (plan §3). */
export async function resetBranchOntoMain(branch: string): Promise<void> {
  const main = await defaultBranch();
  const dir = await ensureWorktree(branch);
  const git = simpleGit(dir);
  await git.raw(['reset', '--hard', main]);
}

/** Files changed between main and the branch (three-dot diff). */
export async function changedFiles(branch: string): Promise<string[]> {
  const main = await defaultBranch();
  const out = await repoGit().raw(['diff', '--name-only', `${main}...${branch}`]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Unified diff of a branch against main. */
export async function branchDiff(branch: string): Promise<string> {
  const main = await defaultBranch();
  return await repoGit().raw(['diff', `${main}...${branch}`]);
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  date: string;
}

export async function branchLog(branch: string, maxCount = 50): Promise<CommitInfo[]> {
  const SEP = '\x1f';
  const out = await repoGit().raw([
    'log',
    branch,
    `--max-count=${maxCount}`,
    `--pretty=format:%H${SEP}%s${SEP}%an${SEP}%aI`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, message, authorName, date] = line.split(SEP);
      return { sha, message, authorName, date };
    });
}

/**
 * Restore an old version: apply the tree of `sha` (optionally only `paths`)
 * onto the branch head as a NEW commit — history is never rewritten.
 */
export async function restoreVersion(
  branch: string,
  sha: string,
  paths: string[] | undefined,
  author: { name: string; email: string },
): Promise<string | null> {
  const dir = await ensureWorktree(branch);
  const git = simpleGit(dir);
  if (paths && paths.length > 0) {
    await git.raw(['checkout', sha, '--', ...paths]);
  } else {
    // whole tree: read old tree into index + working dir, keep history
    await git.raw(['restore', '--source', sha, '--staged', '--worktree', '--', '.']);
  }
  return commitExecution(branch, `Restore ${sha.slice(0, 8)}`, author);
}
