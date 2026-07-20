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
const MAX_HIGHLIGHT_LINES = 5000;

// ── Syntax highlighting (shiki — the same engine Astro bundles) ──────────
const HL_LANGS = [
  'astro', 'typescript', 'tsx', 'javascript', 'jsx', 'json', 'css', 'scss',
  'markdown', 'mdx', 'html', 'yaml', 'toml', 'shellscript', 'python', 'rust',
];
const EXT_LANG: Record<string, string> = {
  astro: 'astro', ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', json: 'json', css: 'css', scss: 'scss', md: 'markdown',
  mdx: 'mdx', html: 'html', htm: 'html', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sh: 'shellscript', bash: 'shellscript', py: 'python',
  rs: 'rust',
};

let hlPromise: Promise<import('shiki').Highlighter> | null = null;
const highlighter = () => {
  hlPromise ??= import('shiki').then((shiki) =>
    shiki.createHighlighter({ themes: ['github-dark'], langs: HL_LANGS }),
  );
  return hlPromise;
};

const escHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Per-line highlighted HTML (aligned with content.split('\n')), or null
 *  for unknown languages / failures — the client falls back to plain text. */
async function highlightLines(text: string, filePath: string): Promise<string[] | null> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const lang = EXT_LANG[ext];
  if (!lang || text.split('\n').length > MAX_HIGHLIGHT_LINES) return null;
  try {
    const hl = await highlighter();
    const { tokens } = hl.codeToTokens(text, { lang: lang as never, theme: 'github-dark' });
    return tokens.map((line) =>
      line
        .map((tk) => `<span style="color:${tk.color ?? 'inherit'}">${escHtml(tk.content)}</span>`)
        .join(''),
    );
  } catch (err) {
    console.warn(`[files] highlight failed for ${filePath}:`, err);
    return null;
  }
}

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
  const content = text.slice(0, MAX_FILE_CHARS);
  return json({
    file: relPath,
    content,
    highlighted: await highlightLines(content, resolved),
    truncated: text.length > MAX_FILE_CHARS,
    size: stat.size,
  });
};
