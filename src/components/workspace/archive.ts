/**
 * Archive view — full-screen modal listing done (archived) chats with the
 * ability to permanently delete each one along with its work branch, worktree,
 * preview and data (DELETE /api/chats/archived).
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import type { AppState } from '../chat/app/state';

// ── Actions ──────────────────────────────────────────────────────────────

export const openArchive = async (): Promise<void> => {
  const a = store.state.workspace.archive;
  a.open = true;
  a.loading = true;
  a.error = null;
  store.notify();
  try {
    const res = await fetch('/api/chats/archived');
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    a.loading = false;
    if (!res.ok) {
      a.error = (data.error as string) ?? `Failed to load the archive (${res.status})`;
    } else {
      a.chats = (data.chats as typeof a.chats) ?? [];
    }
  } catch {
    a.loading = false;
    a.error = 'Network error while loading the archive.';
  }
  store.notify();
};

export const closeArchive = (): void => {
  store.state.workspace.archive.open = false;
  store.notify();
};

export const deleteArchivedChat = async (id: string): Promise<void> => {
  const a = store.state.workspace.archive;
  const row = a.chats.find((c) => c.id === id);
  if (!row) return;
  if (
    !window.confirm(
      `Delete "${row.title}" permanently?\nThis removes the chat, its work branch (${row.workBranch}), worktree and all data.`,
    )
  ) {
    return;
  }
  a.busyId = id;
  store.notify();
  try {
    const res = await fetch(`/api/chats/archived?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      a.chats = a.chats.filter((c) => c.id !== id);
    } else {
      a.error = (data.error as string) ?? `Delete failed (${res.status})`;
    }
  } catch {
    a.error = 'Network error while deleting.';
  }
  a.busyId = null;
  store.notify();
};

// ── Rendering ────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  workflow: 'chat',
  deployment: 'deploy',
  deployments: 'deployments',
};

const renderRow = (row: AppState['workspace']['archive']['chats'][number], busy: boolean): string => {
  const pub = row.publication;
  const pubInfo = pub
    ? `<span class="ws-archive__pub is-${escapeHtml(pub.status)}">${escapeHtml(pub.status)} ${escapeHtml(pub.sha.slice(0, 8))}</span>`
    : '';
  const when = row.archivedAt ? new Date(row.archivedAt).toLocaleString() : '';
  return `<div class="ws-archive__row">
      <div class="ws-archive__info">
        <div class="ws-archive__title">
          ${escapeHtml(row.title)}
          <span class="ws-chat-item__kind">${escapeHtml(KIND_LABEL[row.kind] ?? row.kind)}</span>
          ${pubInfo}
        </div>
        <div class="ws-archive__meta">
          ⎇ ${escapeHtml(row.branch)} · ${escapeHtml(row.workBranch)}
          ${row.createdBy ? ` · ${escapeHtml(row.createdBy)}` : ''} · archived ${escapeHtml(when)}
        </div>
      </div>
      <button type="button" class="ws-mini-button ws-archive__delete" data-action="ws-archive-delete"
        data-chat-id="${escapeHtml(row.id)}" ${busy ? 'disabled' : ''}>
        ${busy ? 'Deleting…' : 'Delete'}
      </button>
    </div>`;
};

export const renderArchiveModal = (state: AppState): string => {
  const a = state.workspace.archive;
  if (!a.open) return '';
  const body = a.loading
    ? '<div class="ws-archive__empty">Loading…</div>'
    : a.chats.length === 0
      ? '<div class="ws-archive__empty">No archived chats yet — chats land here when they are done (published / deployed).</div>'
      : a.chats.map((row) => renderRow(row, a.busyId === row.id)).join('');
  return `<div class="ws-archive" role="dialog" aria-modal="true" aria-label="Archive">
      <div class="ws-archive__panel">
        <div class="ws-archive__head">
          <h2 class="ws-archive__heading">Archive</h2>
          <button type="button" class="ws-mini-button" data-action="ws-archive-close"
            aria-label="Close archive">✕ Close</button>
        </div>
        ${a.error ? `<div class="ws-archive__error">${escapeHtml(a.error)}</div>` : ''}
        <div class="ws-archive__list">${body}</div>
      </div>
    </div>`;
};
