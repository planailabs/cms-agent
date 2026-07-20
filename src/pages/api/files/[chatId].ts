/**
 * GET /api/files/[chatId]?path=… — read-only code browser over the chat's
 * work-branch worktree. A directory path returns its entries (skipping
 * build/VCS dirs and symlinks); a file path returns its content (capped,
 * binary-detected). Every path is jailed to the worktree, symlink escapes
 * included (same jail as the agent's fs tools). Auth: middleware session.
 */
export const prerender = false;

import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { ensureWorktree } from '@/lib/git/engine';
import { jail } from '@/lib/agent/tools/fsTools';
import type { ToolContext } from '@/lib/agent/tools/registry';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro']);
const MAX_FILE_CHARS = 100_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ params, url }) => {
  const relPath = url.searchParams.get('path') ?? '.';

  const chat = await prisma.chat.findUnique({
    where: { id: params.chatId! },
    include: { branch: { select: { name: true } } },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  if (chat.kind !== 'workflow') return json({ error: 'No worktree for this chat' }, 400);

  let worktreePath: string;
  try {
    worktreePath = await ensureWorktree(chat.workBranch, chat.branch.name);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'No worktree' }, 500);
  }

  let resolved: string;
  try {
    resolved = jail({ worktreePath } as ToolContext, relPath);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Invalid path' }, 400);
  }
  if (!fs.existsSync(resolved)) return json({ error: 'Not found' }, 404);

  const stat = fs.lstatSync(resolved);
  if (stat.isDirectory()) {
    const entries = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((e) => !e.isSymbolicLink() && !SKIP_DIRS.has(e.name))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return json({ dir: path.relative(worktreePath, resolved) || '.', entries });
  }

  const buf = fs.readFileSync(resolved);
  if (buf.subarray(0, 8000).includes(0)) {
    return json({ file: relPath, binary: true, size: stat.size });
  }
  const text = buf.toString('utf8');
  return json({
    file: relPath,
    content: text.slice(0, MAX_FILE_CHARS),
    truncated: text.length > MAX_FILE_CHARS,
    size: stat.size,
  });
};
