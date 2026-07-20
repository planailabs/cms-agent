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

/** Load token — a newer load supersedes in-flight responses. */
let cbLoadSeq = 0;

const api = (path: string): string => {
  const chatId = store.state.activeChatId!;
  return `/api/files/${encodeURIComponent(chatId)}?path=${encodeURIComponent(path)}`;
};

export const openCodeBrowser = (): void => {
  const cb = store.state.workspace.codeBrowser;
  cb.open = true;
  cb.error = null;
  store.notify();
  if (!cb.dirs['.']) void loadDir('.');
};

export const closeCodeBrowser = (): void => {
  store.state.workspace.codeBrowser.open = false;
  store.notify();
};

export const loadDir = async (path: string): Promise<void> => {
  const seq = ++cbLoadSeq;
  const cb = store.state.workspace.codeBrowser;
  cb.loading = true;
  store.notify();
  try {
    const res = await fetch(api(path));
    const data = (await res.json()) as {
      entries?: Array<{ name: string; dir: boolean }>;
      error?: string;
    };
    if (seq !== cbLoadSeq) return;
    cb.loading = false;
    if (!res.ok || !data.entries) {
      cb.error = data.error ?? 'Load failed';
    } else {
      cb.dirs[path] = data.entries;
      if (!cb.expanded.includes(path)) cb.expanded.push(path);
    }
    store.notify();
  } catch (err) {
    if (seq !== cbLoadSeq) return;
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

export const openFile = async (path: string): Promise<void> => {
  const seq = ++cbLoadSeq;
  const cb = store.state.workspace.codeBrowser;
  cb.loading = true;
  cb.filePath = path;
  cb.fileLines = [];
  cb.fileHighlighted = null;
  cb.fileTruncated = false;
  cb.selStart = 0;
  cb.selEnd = 0;
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
    if (seq !== cbLoadSeq) return;
    cb.loading = false;
    if (!res.ok) cb.error = data.error ?? 'Load failed';
    else if (data.binary) cb.error = t(uiLocale(), 'workspace.code.binary');
    else {
      cb.fileLines = (data.content ?? '').split('\n');
      cb.fileHighlighted = data.highlighted ?? null;
      cb.fileTruncated = Boolean(data.truncated);
    }
    store.notify();
  } catch (err) {
    if (seq !== cbLoadSeq) return;
    cb.loading = false;
    cb.error = err instanceof Error ? err.message : String(err);
    store.notify();
  }
};

/** Click = single line; shift-click extends to a range (picker-style). */
export const selectLine = (line: number, extend: boolean): void => {
  const cb = store.state.workspace.codeBrowser;
  if (extend && cb.selStart > 0) {
    cb.selEnd = line;
    if (cb.selEnd < cb.selStart) [cb.selStart, cb.selEnd] = [cb.selEnd, cb.selStart];
  } else if (cb.selStart === line && cb.selEnd === line) {
    cb.selStart = 0; // click the single selected line again = deselect
    cb.selEnd = 0;
  } else {
    cb.selStart = line;
    cb.selEnd = line;
  }
  store.notify();
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

const workBranchName = (state: AppState): string | undefined => {
  for (const branch of state.branches) {
    const chat = branch.chats.find((c) => c.id === state.activeChatId);
    if (chat?.workBranch) return chat.workBranch;
  }
  return undefined;
};

// ── Rendering ────────────────────────────────────────────────────────────

const renderTree = (state: AppState, dir: string, depth: number): string => {
  const cb = state.workspace.codeBrowser;
  const entries = cb.dirs[dir];
  if (!entries || !cb.expanded.includes(dir)) return '';
  return entries
    .map((e) => {
      const child = dir === '.' ? e.name : `${dir}/${e.name}`;
      const pad = `style="padding-left:${depth * 0.9 + 0.5}rem"`;
      if (e.dir) {
        const open = cb.expanded.includes(child);
        return `<button type="button" class="ws-cb-entry ws-cb-entry--dir" ${pad}
            data-action="ws-cb-dir" data-path="${escapeHtml(child)}">${open ? '▾' : '▸'} ${escapeHtml(e.name)}</button>${renderTree(state, child, depth + 1)}`;
      }
      const active = cb.filePath === child ? 'is-active' : '';
      return `<button type="button" class="ws-cb-entry ${active}" ${pad}
          data-action="ws-cb-file" data-path="${escapeHtml(child)}">${escapeHtml(e.name)}</button>`;
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
