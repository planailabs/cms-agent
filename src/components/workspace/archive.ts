/**
 * Archive view — full-screen modal listing done (archived) chats with the
 * ability to permanently delete each one along with its work branch, worktree,
 * preview and data (DELETE /api/chats/archived).
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import { switchChat } from '../chat/actions/chat';
import type { AppState } from '../chat/app/state';
import { closeWindow, openWindow, registerWindow } from './window';

// ── Actions ──────────────────────────────────────────────────────────────

export const openArchive = (): void => openWindow('archive');

export const closeArchive = (): void => closeWindow();

const loadArchive = async (): Promise<void> => {
  const a = store.state.workspace.archive;
  a.loading = true;
  a.error = null;
  store.notify();
  try {
    const res = await fetch('/api/chats/archived');
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    a.loading = false;
    if (!res.ok) {
      a.error =
        (data.error as string) ??
        t(uiLocale(), 'workspace.archive.loadFailed', { status: res.status });
    } else {
      a.chats = (data.chats as typeof a.chats) ?? [];
    }
  } catch {
    a.loading = false;
    a.error = t(uiLocale(), 'workspace.archive.loadNetworkError');
  }
  store.notify();
};

/** Open an archived chat read-only. Kind, title and the archived flag sync
 *  over with the history load — no carry-over needed here. */
export const openArchivedChat = (id: string): void => {
  closeArchive();
  switchChat(id);
};

export const deleteArchivedChat = async (id: string): Promise<void> => {
  const a = store.state.workspace.archive;
  const row = a.chats.find((c) => c.id === id);
  if (!row) return;
  if (
    !window.confirm(
      t(uiLocale(), 'workspace.archive.deleteConfirm', {
        title: row.title,
        workBranch: row.workBranch,
      }),
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
      a.error =
        (data.error as string) ??
        t(uiLocale(), 'workspace.archive.deleteFailed', { status: res.status });
    }
  } catch {
    a.error = t(uiLocale(), 'workspace.archive.deleteNetworkError');
  }
  a.busyId = null;
  store.notify();
};

// ── Rendering ────────────────────────────────────────────────────────────

/** Catalog keys only — labels resolve at render time. */
const KIND_LABEL_KEY: Record<string, string> = {
  workflow: 'workspace.archive.kind.workflow',
  deployment: 'workspace.archive.kind.deployment',
  deployments: 'workspace.archive.kind.deployments',
};

/** Status label: catalog entry when known, raw status otherwise. */
const statusLabel = (status: string): string => {
  const key = `workspace.status.${status}`;
  const label = t(uiLocale(), key);
  return label === key ? status : label;
};

const renderRow = (row: AppState['workspace']['archive']['chats'][number], busy: boolean): string => {
  const locale = uiLocale();
  const pub = row.publication;
  const pubInfo = pub
    ? `<span class="ws-archive__pub is-${escapeHtml(pub.status)}">${escapeHtml(statusLabel(pub.status))} ${escapeHtml(pub.sha.slice(0, 8))}</span>`
    : '';
  const when = row.archivedAt ? new Date(row.archivedAt).toLocaleString(locale) : '';
  const kindLabel = KIND_LABEL_KEY[row.kind] ? t(locale, KIND_LABEL_KEY[row.kind]) : row.kind;
  return `<div class="ws-archive__row">
      <div class="ws-archive__info ws-archive__info--clickable" data-action="ws-archive-view"
        data-chat-id="${escapeHtml(row.id)}" role="button" tabindex="0"
        title="${escapeHtml(t(locale, 'workspace.archive.viewTitle'))}">
        <div class="ws-archive__title">
          ${escapeHtml(row.title)}
          <span class="ws-chat-item__kind">${escapeHtml(kindLabel)}</span>
          ${pubInfo}
        </div>
        <div class="ws-archive__meta">
          ⎇ ${escapeHtml(row.branch)} · ${escapeHtml(row.workBranch)}
          ${row.createdBy ? ` · ${escapeHtml(row.createdBy)}` : ''} · ${escapeHtml(t(locale, 'workspace.archive.archivedAt', { when }))}
        </div>
      </div>
      <button type="button" class="ws-mini-button ws-archive__delete" data-action="ws-archive-delete"
        data-chat-id="${escapeHtml(row.id)}" ${busy ? 'disabled' : ''}>
        ${escapeHtml(t(locale, busy ? 'workspace.archive.deleting' : 'workspace.archive.delete'))}
      </button>
    </div>`;
};

export const renderArchiveModal = (state: AppState): string => {
  const locale = uiLocale();
  const a = state.workspace.archive;
  const body = a.loading
    ? `<div class="ws-archive__empty">${escapeHtml(t(locale, 'workspace.archive.loading'))}</div>`
    : a.chats.length === 0
      ? `<div class="ws-archive__empty">${escapeHtml(t(locale, 'workspace.archive.empty'))}</div>`
      : a.chats.map((row) => renderRow(row, a.busyId === row.id)).join('');
  return `<div class="ws-archive" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(locale, 'workspace.archive.heading'))}">
      <div class="ws-archive__panel">
        <div class="ws-archive__head">
          <h2 class="ws-archive__heading">${escapeHtml(t(locale, 'workspace.archive.heading'))}</h2>
          <button type="button" class="ws-mini-button" data-action="ws-archive-close"
            aria-label="${escapeHtml(t(locale, 'workspace.archive.closeLabel'))}">${escapeHtml(t(locale, 'workspace.archive.close'))}</button>
        </div>
        ${a.error ? `<div class="ws-archive__error">${escapeHtml(a.error)}</div>` : ''}
        <div class="ws-archive__list">${body}</div>
      </div>
    </div>`;
};

registerWindow({
  kind: 'archive',
  order: 50,
  icon: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.6" width="12.4" height="3.4" rx="1"/><path d="M3 6v6.2a1.2 1.2 0 001.2 1.2h7.6A1.2 1.2 0 0013 12.2V6M6.4 8.8h3.2"/></svg>`,
  tooltipKey: 'workspace.sidebar.archiveTitle',
  railAction: 'ws-archive-open',
  render: renderArchiveModal,
  onOpen: () => void loadArchive(),
});
