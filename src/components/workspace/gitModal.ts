/**
 * Git modal — full-screen overlay with a GitHub-flavored view of a branch's
 * commits and their diffs. Work branches show their exclusive commits plus
 * the target branch's history greyed out below; target branches show all
 * commits. Clicking a commit opens its `git show` patch rendered per file.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import type { GitCommitRow } from './state';

// ── Actions ──────────────────────────────────────────────────────────────

/** Branch the modal opens on: active workflow chat's work branch, else the
 *  active target branch. */
const defaultBranch = (state: AppState): string | null => {
  for (const branch of state.branches) {
    const chat = branch.chats.find((c) => c.id === state.activeChatId);
    if (chat && (chat.kind ?? 'workflow') === 'workflow' && chat.workBranch) return chat.workBranch;
  }
  return state.branches.find((b) => b.id === state.activeBranchId)?.name ?? null;
};

export const openGitModal = (): void => {
  const g = store.state.workspace.git;
  g.open = true;
  g.selectedSha = null;
  g.patch = null;
  void loadGitCommits(defaultBranch(store.state));
};

export const closeGitModal = (): void => {
  store.state.workspace.git.open = false;
  store.notify();
};

export const loadGitCommits = async (branch: string | null): Promise<void> => {
  const g = store.state.workspace.git;
  g.branch = branch;
  g.commits = [];
  g.target = null;
  g.error = null;
  g.selectedSha = null;
  g.patch = null;
  if (!branch) {
    store.notify();
    return;
  }
  g.loading = true;
  store.notify();
  try {
    const res = await fetch(`/api/git/commits?branch=${encodeURIComponent(branch)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      g.target = (data.target as string | null) ?? null;
      g.commits = (data.commits as GitCommitRow[]) ?? [];
    } else {
      g.error =
        (data.error as string) ?? t(uiLocale(), 'workspace.git.loadFailed', { status: res.status });
    }
  } catch {
    g.error = t(uiLocale(), 'workspace.git.networkError');
  }
  g.loading = false;
  store.notify();
};

export const selectGitCommit = async (sha: string): Promise<void> => {
  const g = store.state.workspace.git;
  g.selectedSha = sha;
  g.patch = null;
  g.patchLoading = true;
  g.error = null;
  store.notify();
  try {
    const res = await fetch(`/api/git/commit?sha=${encodeURIComponent(sha)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      g.patch = (data.patch as string) ?? '';
    } else {
      g.error =
        (data.error as string) ?? t(uiLocale(), 'workspace.git.loadFailed', { status: res.status });
      g.selectedSha = null;
    }
  } catch {
    g.error = t(uiLocale(), 'workspace.git.networkError');
    g.selectedSha = null;
  }
  g.patchLoading = false;
  store.notify();
};

export const backToGitList = (): void => {
  const g = store.state.workspace.git;
  g.selectedSha = null;
  g.patch = null;
  store.notify();
};

// ── Rendering ────────────────────────────────────────────────────────────

const relativeDate = (iso: string, locale: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const s = Math.round((then - Date.now()) / 1000);
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, secs] of steps) {
    if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit);
  }
  return rtf.format(s, 'second');
};

const renderCommitRow = (c: GitCommitRow, locale: string): string =>
  `<button type="button" class="ws-git__row ${c.onTarget ? 'is-target' : ''}"
      data-action="ws-git-commit" data-sha="${escapeHtml(c.sha)}">
    <span class="ws-git__info">
      <span class="ws-git__message">${escapeHtml(c.message)}</span>
      <span class="ws-git__meta">${escapeHtml(c.authorName)} · ${escapeHtml(relativeDate(c.date, locale))}</span>
    </span>
    <span class="ws-git__sha ws-mono">${escapeHtml(c.sha.slice(0, 7))}</span>
  </button>`;

/** Commit list: exclusive commits first, then the greyed target history with
 *  a divider naming the target branch. `git log` order already gives us that
 *  split contiguously in practice; group explicitly to be safe. */
const renderList = (state: AppState): string => {
  const locale = uiLocale();
  const g = state.workspace.git;
  if (g.loading) return `<div class="ws-git__empty">${escapeHtml(t(locale, 'workspace.git.loading'))}</div>`;
  if (g.commits.length === 0)
    return `<div class="ws-git__empty">${escapeHtml(t(locale, 'workspace.git.empty'))}</div>`;
  const own = g.commits.filter((c) => !c.onTarget);
  const onTarget = g.commits.filter((c) => c.onTarget);
  const divider =
    onTarget.length > 0 && g.target
      ? `<div class="ws-git__divider">${escapeHtml(t(locale, 'workspace.git.onTarget', { target: g.target }))}</div>`
      : '';
  return (
    own.map((c) => renderCommitRow(c, locale)).join('') +
    divider +
    onTarget.map((c) => renderCommitRow(c, locale)).join('')
  );
};

// ── Diff rendering (git show → GitHub-like file cards) ───────────────────

interface PatchFile {
  header: string;
  lines: string[];
}

/** Splits `git show` output into the commit preamble (message + stat) and
 *  per-file sections starting at each `diff --git`. */
const parsePatch = (patch: string): { preamble: string; files: PatchFile[] } => {
  const lines = patch.split('\n');
  const firstDiff = lines.findIndex((l) => l.startsWith('diff --git '));
  if (firstDiff < 0) return { preamble: patch, files: [] };
  const preamble = lines.slice(0, firstDiff).join('\n');
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  for (const line of lines.slice(firstDiff)) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/path b/path` → the b/ path (rename-safe enough)
      const m = / b\/(.*)$/.exec(line);
      current = { header: m?.[1] ?? line, lines: [] };
      files.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return { preamble, files };
};

const lineClass = (line: string): string => {
  if (line.startsWith('+++') || line.startsWith('---')) return 'is-file';
  if (line.startsWith('@@')) return 'is-hunk';
  if (line.startsWith('+')) return 'is-add';
  if (line.startsWith('-')) return 'is-del';
  return '';
};

const renderFile = (file: PatchFile): string => {
  const adds = file.lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = file.lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const body = file.lines
    .filter((l) => !l.startsWith('index ') && !l.startsWith('+++') && !l.startsWith('---'))
    .map((l) => `<div class="ws-git__line ${lineClass(l)}">${escapeHtml(l) || ' '}</div>`)
    .join('');
  return `<div class="ws-git__file">
      <div class="ws-git__file-head">
        <span class="ws-mono">${escapeHtml(file.header)}</span>
        <span class="ws-git__counts"><span class="is-add">+${adds}</span> <span class="is-del">−${dels}</span></span>
      </div>
      <div class="ws-git__patch ws-mono">${body}</div>
    </div>`;
};

const renderDiff = (state: AppState): string => {
  const locale = uiLocale();
  const g = state.workspace.git;
  if (g.patchLoading)
    return `<div class="ws-git__empty">${escapeHtml(t(locale, 'workspace.git.diffLoading'))}</div>`;
  if (!g.patch) return '';
  const { preamble, files } = parsePatch(g.patch);
  return `<div class="ws-git__preamble ws-mono">${escapeHtml(preamble.trim())}</div>
    ${files.map(renderFile).join('')}`;
};

// ── Modal shell ──────────────────────────────────────────────────────────

/** All branches offered by the selector: target branches, and under each its
 *  chats' work branches (workflow chats only). */
const branchOptions = (state: AppState, selected: string | null): string =>
  state.branches
    .map((branch) => {
      const chats = branch.chats
        .filter((c) => (c.kind ?? 'workflow') === 'workflow' && c.workBranch)
        .map(
          (c) =>
            `<option value="${escapeHtml(c.workBranch)}" ${c.workBranch === selected ? 'selected' : ''}>
              ⎇ ${escapeHtml(c.workBranch)} · ${escapeHtml(c.title)}</option>`,
        )
        .join('');
      return `<option value="${escapeHtml(branch.name)}" ${branch.name === selected ? 'selected' : ''}>⎇ ${escapeHtml(branch.name)}</option>${chats}`;
    })
    .join('');

export const renderGitModal = (state: AppState): string => {
  const locale = uiLocale();
  const g = state.workspace.git;
  if (!g.open) return '';

  const selected = g.selectedSha ? g.commits.find((c) => c.sha === g.selectedSha) : null;
  const head = g.selectedSha
    ? `<button type="button" class="ws-mini-button" data-action="ws-git-back">← ${escapeHtml(t(locale, 'workspace.git.back'))}</button>
       <span class="ws-git__head-message">${escapeHtml(selected?.message ?? '')}</span>
       <span class="ws-git__sha ws-mono">${escapeHtml(g.selectedSha.slice(0, 7))}</span>`
    : `<h2 class="ws-archive__heading">${escapeHtml(t(locale, 'workspace.git.heading'))}</h2>
       <select class="dash-input ws-git__branch" data-action="ws-git-branch">
         ${branchOptions(state, g.branch)}
       </select>`;

  return `<div class="ws-archive ws-git" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(locale, 'workspace.git.heading'))}">
      <div class="ws-archive__panel">
        <div class="ws-archive__head ws-git__head">
          <div class="ws-git__head-left">${head}</div>
          <button type="button" class="ws-mini-button" data-action="ws-git-close"
            aria-label="${escapeHtml(t(locale, 'workspace.git.close'))}">${escapeHtml(t(locale, 'workspace.git.close'))}</button>
        </div>
        ${g.error ? `<div class="ws-archive__error">${escapeHtml(g.error)}</div>` : ''}
        <div class="ws-archive__list ws-git__body">
          ${g.selectedSha ? renderDiff(state) : renderList(state)}
        </div>
      </div>
    </div>`;
};
