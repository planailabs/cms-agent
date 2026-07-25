/**
 * Code browser — full-screen modal (git/caps-modal shell) over the chat's
 * work-branch worktree, read-only. Click a line (shift-click for a range)
 * and "Add as chat context" attaches a code chip to the composer — the
 * message then carries the file/line-range/snippet as pageContext, the same
 * flow the preview element picker uses.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';

const MAX_SNIPPET_CHARS = 4000;

let cbFileLoadSeq = 0;
const cbDirLoadSeq = new Map<string, number>();

const api = (path: string, mode?: 'raw' | 'download'): string => {
  const chatId = store.state.activeChatId!;
  const url = `/api/files/${encodeURIComponent(chatId)}?path=${encodeURIComponent(path)}`;
  return mode ? `${url}&mode=${mode}` : url;
};

export const openCodeBrowser = (): void => {
  const cb = store.state.workspace.codeBrowser;
  cb.open = true;
  cb.error = null;
  store.notify();
  for (const path of new Set(['.', ...cb.expanded]))
    if (!cb.dirs[path]) void loadDir(path);
};

export const closeCodeBrowser = (): void => {
  store.state.workspace.codeBrowser.open = false;
  store.notify();
};

export const loadDir = async (path: string): Promise<void> => {
  const seq = (cbDirLoadSeq.get(path) ?? 0) + 1;
  cbDirLoadSeq.set(path, seq);
  const cb = store.state.workspace.codeBrowser;
  cb.loading = true;
  store.notify();
  try {
    const res = await fetch(api(path));
    const data = (await res.json()) as {
      entries?: Array<{ name: string; dir: boolean }>;
      error?: string;
    };
    if (seq !== cbDirLoadSeq.get(path)) return;
    cb.loading = false;
    if (!res.ok || !data.entries) {
      cb.error = data.error ?? 'Load failed';
    } else {
      cb.dirs[path] = data.entries;
      if (!cb.expanded.includes(path)) cb.expanded.push(path);
    }
    store.notify();
  } catch (err) {
    if (seq !== cbDirLoadSeq.get(path)) return;
    cb.loading = false;
    cb.error = err instanceof Error ? err.message : String(err);
    store.notify();
  }
};

export const toggleDir = (path: string): void => {
  const cb = store.state.workspace.codeBrowser;
  const idx = cb.expanded.indexOf(path);
  if (idx >= 0) {
    cb.expanded.splice(idx, 1);
    store.notify();
  } else if (cb.dirs[path]) {
    cb.expanded.push(path);
    store.notify();
  } else {
    void loadDir(path);
  }
};

export const workFileTarget = (href: string): { path: string; line: number } | null => {
  if (!href.startsWith('/work/')) return null;
  try {
    const match = decodeURIComponent(href.slice(6)).match(/^(.*?)(?::(\d+))?$/);
    return match?.[1] ? { path: match[1], line: Number(match[2] ?? 0) } : null;
  } catch {
    return null;
  }
};

export const openFile = async (path: string, line = 0): Promise<void> => {
  const seq = ++cbFileLoadSeq;
  const cb = store.state.workspace.codeBrowser;
  cb.loading = true;
  cb.filePath = path;
  cb.fileLines = [];
  cb.fileHighlighted = null;
  cb.fileTruncated = false;
  cb.selStart = line;
  cb.selEnd = line;
  cb.error = null;
  store.notify();
  try {
    const res = await fetch(api(path));
    const data = (await res.json()) as {
      content?: string;
      highlighted?: string[] | null;
      truncated?: boolean;
      binary?: boolean;
      error?: string;
    };
    if (seq !== cbFileLoadSeq) return;
    cb.loading = false;
    if (!res.ok) cb.error = data.error ?? 'Load failed';
    else if (data.binary) cb.error = t(uiLocale(), 'workspace.code.binary');
    else {
      cb.fileLines = (data.content ?? '').split('\n');
      cb.fileHighlighted = data.highlighted ?? null;
      cb.fileTruncated = Boolean(data.truncated);
    }
    store.notify();
    if (line)
      requestAnimationFrame(() =>
        document.querySelector(`[data-action="ws-cb-line"][data-line="${line}"]`)?.scrollIntoView({ block: 'center' }),
      );
  } catch (err) {
    if (seq !== cbFileLoadSeq) return;
    cb.loading = false;
    cb.error = err instanceof Error ? err.message : String(err);
    store.notify();
  }
};

// Multi-line selection: press starts an anchor, dragging over lines extends
// the range live (rAF-throttled — every update re-renders the modal), and
// shift-press extends from the existing anchor instead of restarting.
let dragAnchor = 0;
let dragging = false;
let pendingLine = 0;
let rafId = 0;

const applyRange = (line: number): void => {
  const cb = store.state.workspace.codeBrowser;
  cb.selStart = Math.min(dragAnchor, line);
  cb.selEnd = Math.max(dragAnchor, line);
  store.notify();
};

export const beginLineSelect = (line: number, extend: boolean): void => {
  const cb = store.state.workspace.codeBrowser;
  if (!extend && cb.selStart === line && cb.selEnd === line) {
    // pressing the single selected line again = deselect
    cb.selStart = 0;
    cb.selEnd = 0;
    dragAnchor = 0;
    store.notify();
    return;
  }
  if (!(extend && dragAnchor > 0)) dragAnchor = line;
  dragging = true;
  applyRange(line);
};

export const dragLineSelect = (line: number): void => {
  if (!dragging) return;
  pendingLine = line;
  if (typeof requestAnimationFrame !== 'function') {
    applyRange(pendingLine);
    return;
  }
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (dragging) applyRange(pendingLine);
  });
};

export const endLineSelect = (): void => {
  dragging = false;
};

/** Attach the selection as the composer's context chip and close. */
export const addCodeContext = (): void => {
  const ws = store.state.workspace;
  const cb = ws.codeBrowser;
  if (!cb.filePath || cb.selStart < 1) return;
  const snippet = cb.fileLines
    .slice(cb.selStart - 1, cb.selEnd)
    .join('\n')
    .slice(0, MAX_SNIPPET_CHARS);
  ws.contextChip = {
    kind: 'code',
    context: {
      url: cb.filePath,
      branch: workBranchName(store.state),
      code: { path: cb.filePath, startLine: cb.selStart, endLine: cb.selEnd, snippet },
    },
  };
  cb.open = false;
  store.notify();
};

export const copyOpenFile = async (): Promise<boolean> => {
  const cb = store.state.workspace.codeBrowser;
  if (!cb.filePath) return false;
  try {
    const res = await fetch(api(cb.filePath, 'raw'));
    if (!res.ok) throw new Error(`Copy failed (${res.status})`);
    await navigator.clipboard.writeText(await res.text());
    return true;
  } catch (err) {
    cb.error = err instanceof Error ? err.message : String(err);
    store.notify();
    return false;
  }
};

const workBranchName = (state: AppState): string | undefined => {
  for (const branch of state.branches) {
    const chat = branch.chats.find((c) => c.id === state.activeChatId);
    if (chat?.workBranch) return chat.workBranch;
  }
  return undefined;
};

// ── Rendering ────────────────────────────────────────────────────────────

/** Per-filetype icon glyph + color (language brand colors, GitHub-style). */
const FILE_META: Record<string, { glyph: string; color: string }> = {
  astro: { glyph: 'A', color: '#ff5d01' },
  ts: { glyph: 'TS', color: '#3178c6' },
  mts: { glyph: 'TS', color: '#3178c6' },
  tsx: { glyph: 'TX', color: '#3178c6' },
  js: { glyph: 'JS', color: '#f1e05a' },
  mjs: { glyph: 'JS', color: '#f1e05a' },
  cjs: { glyph: 'JS', color: '#f1e05a' },
  jsx: { glyph: 'JX', color: '#f1e05a' },
  json: { glyph: '{}', color: '#8bc34a' },
  css: { glyph: '#', color: '#663399' },
  scss: { glyph: '#', color: '#c6538c' },
  md: { glyph: 'M↓', color: '#9e9e9e' },
  mdx: { glyph: 'M↓', color: '#fcb32c' },
  html: { glyph: '<>', color: '#e34c26' },
  yml: { glyph: '⚙', color: '#a0a0a0' },
  yaml: { glyph: '⚙', color: '#a0a0a0' },
  toml: { glyph: '⚙', color: '#a0a0a0' },
  sh: { glyph: '$', color: '#89e051' },
  py: { glyph: 'PY', color: '#3572a5' },
  rs: { glyph: 'RS', color: '#dea584' },
  svg: { glyph: '◍', color: '#ffb13b' },
  png: { glyph: '◍', color: '#26a69a' },
  jpg: { glyph: '◍', color: '#26a69a' },
  jpeg: { glyph: '◍', color: '#26a69a' },
  webp: { glyph: '◍', color: '#26a69a' },
  gif: { glyph: '◍', color: '#26a69a' },
  ico: { glyph: '◍', color: '#26a69a' },
};

const fileIcon = (name: string): string => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const meta = FILE_META[ext] ?? { glyph: '·', color: 'inherit' };
  return `<span class="ws-cb-icon" style="color:${meta.color}" aria-hidden="true">${escapeHtml(meta.glyph)}</span>`;
};

const renderTree = (state: AppState, dir: string, depth: number): string => {
  const cb = state.workspace.codeBrowser;
  const entries = cb.dirs[dir];
  if (!entries || !cb.expanded.includes(dir)) return '';
  return entries
    .map((e) => {
      const child = dir === '.' ? e.name : `${dir}/${e.name}`;
      const pad = `style="padding-left:${depth * 0.9 + 0.4}rem"`;
      if (e.dir) {
        const open = cb.expanded.includes(child);
        return `<button type="button" class="ws-cb-entry ws-cb-entry--dir" ${pad}
            data-action="ws-cb-dir" data-path="${escapeHtml(child)}"><span class="ws-cb-icon" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="ws-cb-name">${escapeHtml(e.name)}</span></button>${renderTree(state, child, depth + 1)}`;
      }
      const active = cb.filePath === child ? 'is-active' : '';
      return `<button type="button" class="ws-cb-entry ${active}" ${pad}
          data-action="ws-cb-file" data-path="${escapeHtml(child)}">${fileIcon(e.name)}<span class="ws-cb-name">${escapeHtml(e.name)}</span></button>`;
    })
    .join('');
};

const renderFile = (state: AppState): string => {
  const locale = uiLocale();
  const cb = state.workspace.codeBrowser;
  if (!cb.filePath) {
    return `<span class="ws-empty-note">${escapeHtml(t(locale, 'workspace.code.pickFile'))}</span>`;
  }
  const lines = cb.fileLines
    .map((line, i) => {
      const n = i + 1;
      const sel = n >= cb.selStart && n <= cb.selEnd ? 'is-selected' : '';
      // Highlighted HTML comes from OUR server (shiki-escaped) — trusted.
      const code = cb.fileHighlighted?.[i] ?? escapeHtml(line);
      return `<div class="ws-cb-line ${sel}" data-action="ws-cb-line" data-line="${n}"><span class="ws-cb-ln">${n}</span><span class="ws-cb-code">${code || ' '}</span></div>`;
    })
    .join('');
  return `<div class="ws-cb-file ws-mono">${lines}</div>
    ${cb.fileTruncated ? `<p class="ws-empty-note">${escapeHtml(t(locale, 'workspace.code.truncated'))}</p>` : ''}`;
};

export const renderCodeBrowser = (state: AppState): string => {
  const locale = uiLocale();
  const cb = state.workspace.codeBrowser;
  if (!cb.open) return '';
  const hasSel = cb.selStart > 0 && cb.filePath;

  return `<div class="ws-archive ws-git" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(locale, 'workspace.code.heading'))}">
      <div class="ws-archive__panel">
        <div class="ws-archive__head ws-git__head">
          <div class="ws-git__head-left">
            <h2 class="ws-archive__heading">${escapeHtml(t(locale, 'workspace.code.heading'))}</h2>
            ${cb.filePath ? `<span class="ws-mono ws-cb-path">${escapeHtml(cb.filePath)}${hasSel ? `:${cb.selStart}${cb.selEnd > cb.selStart ? `-${cb.selEnd}` : ''}` : ''}</span>` : ''}
          </div>
          <div class="ws-git__head-left">
            ${cb.filePath ? `<button type="button" class="ws-mini-button" data-action="ws-cb-copy"
              title="${escapeHtml(t(locale, 'workspace.code.copyTitle'))}">${escapeHtml(t(locale, 'workspace.code.copy'))}</button>
            <a class="ws-mini-button" href="${escapeHtml(api(cb.filePath, 'download'))}" download
              title="${escapeHtml(t(locale, 'workspace.code.downloadTitle'))}">${escapeHtml(t(locale, 'workspace.code.download'))}</a>` : ''}
            <button type="button" class="ws-mini-button ws-mini-button--primary" data-action="ws-cb-add"
              ${hasSel ? '' : 'disabled'} title="${escapeHtml(t(locale, 'workspace.code.addTitle'))}">${escapeHtml(t(locale, 'workspace.code.add'))}</button>
            <button type="button" class="ws-mini-button" data-action="ws-cb-modal-close"
              aria-label="${escapeHtml(t(locale, 'workspace.git.close'))}">${escapeHtml(t(locale, 'workspace.git.close'))}</button>
          </div>
        </div>
        ${cb.error ? `<div class="ws-archive__error">${escapeHtml(cb.error)}</div>` : ''}
        <div class="ws-archive__list ws-git__body ws-cb-body">
          <div class="ws-cb-tree">${renderTree(state, '.', 0) || `<span class="ws-empty-note">${cb.loading ? '…' : escapeHtml(t(locale, 'workspace.code.empty'))}</span>`}</div>
          <div class="ws-cb-view">${renderFile(state)}</div>
        </div>
      </div>
    </div>`;
};
