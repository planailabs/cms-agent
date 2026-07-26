/**
 * .scratch/ worktree scratch area: writable via the regular file tools in
 * every phase, git-excluded, never in modifiedPaths; move_file promotes
 * artifacts into the repo during EXECUTE only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerFsTools, isScratchPath } from '@/lib/agent/tools/fsTools';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';

registerFsTools();

let tmp: string;

function ctx(phase: ToolContext['workflowPhase'], modifiedPaths = new Set<string>()): ToolContext {
  return {
    chatId: 'c',
    branchId: 'b',
    branchName: 'main',
    userId: 'u',
    workflowPhase: phase,
    chatKind: 'workflow',
    worktreePath: tmp,
    userContext: new Map(),
    modifiedPaths,
  };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-scratchdir-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'site.md'), '# site\n');
});

describe('isScratchPath', () => {
  it('normalizes before matching', () => {
    expect(isScratchPath('.scratch/a.md')).toBe(true);
    expect(isScratchPath('.scratch')).toBe(true);
    expect(isScratchPath('foo/../.scratch/a')).toBe(true);
    expect(isScratchPath('.scratch/../src/x')).toBe(false);
    expect(isScratchPath('.scratchy/a')).toBe(false);
    expect(isScratchPath('src/x.md')).toBe(false);
  });
});

describe('.scratch/ via regular file tools', () => {
  it('writes, edits, and removes scratch files in the PLAN phase', async () => {
    const modified = new Set<string>();
    const w = await executeTool(
      'write_file',
      { path: '.scratch/notes.md', content: 'draft' },
      ctx('plan', modified),
    );
    expect(JSON.parse(w).success).toBe(true);
    expect(modified.size).toBe(0); // scratch never counts as a site modification

    const e = await executeTool(
      'edit_file',
      { path: '.scratch/notes.md', oldText: 'draft', newText: 'draft v2' },
      ctx('plan', modified),
    );
    expect(JSON.parse(e).success).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '.scratch', 'notes.md'), 'utf8')).toBe('draft v2');

    const r = await executeTool('remove_file', { path: '.scratch/notes.md' }, ctx('plan', modified));
    expect(JSON.parse(r).success).toBe(true);
    expect(modified.size).toBe(0);
  });

  it('rejects site writes outside the execute phase', async () => {
    for (const [tool, input] of [
      ['write_file', { path: 'src/hacked.md', content: 'x' }],
      ['edit_file', { path: 'src/site.md', oldText: 'site', newText: 'x' }],
      ['remove_file', { path: 'src/site.md' }],
    ] as const) {
      const res = await executeTool(tool, input, ctx('preview'));
      expect(JSON.parse(res).error, tool).toMatch(/Only \.scratch\/ is writable/);
    }
    // normalization is not fooled
    const sneaky = await executeTool(
      'write_file',
      { path: '.scratch/../src/hacked.md', content: 'x' },
      ctx('plan'),
    );
    expect(JSON.parse(sneaky).error).toMatch(/Only \.scratch\/ is writable/);
  });

  it('move_file promotes scratch artifacts only during execute', async () => {
    await executeTool(
      'write_file',
      { path: '.scratch/shot.png', content: 'png-bytes' },
      ctx('plan'),
    );

    const denied = await executeTool(
      'move_file',
      { from: '.scratch/shot.png', to: 'assets/shot.png' },
      ctx('plan'),
    );
    expect(JSON.parse(denied).error).toMatch(/Only \.scratch\/ is writable/);

    // within scratch: fine in plan
    const within = await executeTool(
      'move_file',
      { from: '.scratch/shot.png', to: '.scratch/img/shot.png' },
      ctx('plan'),
    );
    expect(JSON.parse(within).success).toBe(true);

    const modified = new Set<string>();
    const promoted = await executeTool(
      'move_file',
      { from: '.scratch/img/shot.png', to: 'assets/shot.png' },
      ctx('execute', modified),
    );
    expect(JSON.parse(promoted).success).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'assets', 'shot.png'))).toBe(true);
    expect([...modified]).toEqual(['assets/shot.png']);

    const escape = await executeTool(
      'move_file',
      { from: 'assets/shot.png', to: '../outside.png' },
      ctx('execute'),
    );
    expect(JSON.parse(escape).error).toMatch(/escapes the repository/);
  });

  it('list_pages never lists scratch files as site pages', async () => {
    process.env.SITE_BACKEND = 'static';
    const { resetEnvCache } = await import('@/lib/env');
    const { resetActiveBackend } = await import('@/lib/site');
    resetEnvCache();
    resetActiveBackend();
    try {
      fs.mkdirSync(path.join(tmp, '.scratch'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.scratch', 'draft.html'), '<html></html>');
      fs.writeFileSync(path.join(tmp, 'about.html'), '<html></html>');
      const pages = await executeTool('list_pages', {}, ctx('plan'));
      expect(pages).toContain('about.html');
      expect(pages).not.toContain('.scratch/draft.html');
    } finally {
      process.env.SITE_BACKEND = 'astro';
      resetEnvCache();
      resetActiveBackend();
    }
  });
});

describe('.scratch/ stays out of git', () => {
  it('is invisible to status and add -A once excludes are ensured', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-scratchgit-'));
    const git = simpleGit(repoDir);
    await git.init(['--initial-branch=main'] as never);
    await git.addConfig('user.name', 'T');
    await git.addConfig('user.email', 't@t');
    fs.writeFileSync(path.join(repoDir, 'a.md'), 'a\n');
    await git.add(['-A']);
    await git.commit('init');

    // What ensureRepoExcludes writes for .scratch/ (private fn — mirror the line)
    fs.mkdirSync(path.join(repoDir, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(repoDir, '.git', 'info', 'exclude'), '.scratch/\n');

    fs.mkdirSync(path.join(repoDir, '.scratch'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.scratch', 'draft.md'), 'never committed');

    const status = await git.status();
    expect(status.files).toEqual([]);
    await git.add(['-A']);
    expect((await git.status()).staged).toEqual([]);
  });
});
