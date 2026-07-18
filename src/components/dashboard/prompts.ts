/**
 * System Prompts tab — ported from chat/'s dashboard prompts.ts.
 *
 * User picker (search backed by GET /api/admin/users) + inline textarea
 * editor for the per-user system prompt extension. Chat modes are gone in
 * this app, so there is a single extension per user:
 * GET /api/admin/system-prompt-extension?userId=… / PUT { userId, content }
 * (empty content deletes the extension).
 */

import { t, uiLocale } from '@/lib/i18n';
import {
  escapeHtml,
  fetchJson,
  fetchUsers,
  showStatus,
  type AdminUser,
} from './logic';

export function initPrompts(container: HTMLElement): void {
  const searchInput = container.querySelector('.search-input') as HTMLInputElement;
  const searchBtn = container.querySelector('.search-btn') as HTMLButtonElement;
  const userList = container.querySelector('.user-list') as HTMLElement;
  const editor = container.querySelector('.prompt-editor') as HTMLElement;
  const editorUserInfo = container.querySelector('.prompt-editor-user') as HTMLElement;
  const contentArea = container.querySelector('.prompt-content') as HTMLTextAreaElement;
  const saveBtn = container.querySelector('.prompt-save-btn') as HTMLButtonElement;
  const clearBtn = container.querySelector('.prompt-clear-btn') as HTMLButtonElement;
  const statusMsg = container.querySelector('.dash-status') as HTMLElement;

  let selectedUser: AdminUser | null = null;

  // ── Search / user picker ────────────────────────────────────────────────────

  async function searchUsers() {
    const q = searchInput.value.trim();
    searchBtn.textContent = t(uiLocale(), 'dashboard.common.searching');
    searchBtn.disabled = true;
    userList.innerHTML = `<div class="dash-td-muted animate-pulse">${t(uiLocale(), 'dashboard.common.loadingUsers')}</div>`;

    try {
      renderUsers(await fetchUsers(q || undefined));
    } catch (err) {
      userList.innerHTML = `<div class="dash-td-error">${
        err instanceof Error
          ? escapeHtml(err.message)
          : t(uiLocale(), 'dashboard.common.failedLoadUsers')
      }</div>`;
    } finally {
      searchBtn.textContent = t(uiLocale(), 'dashboard.common.search');
      searchBtn.disabled = false;
    }
  }

  function renderUsers(users: AdminUser[]) {
    if (users.length === 0) {
      userList.innerHTML = `<div class="dash-td-muted">${t(uiLocale(), 'dashboard.common.noUsersFound')}</div>`;
      return;
    }

    userList.innerHTML = users
      .map(
        (u) => `
        <button type="button" class="dash-user-card${selectedUser?.id === u.id ? ' is-selected' : ''}" data-user-id="${escapeHtml(u.id)}">
          <span class="dash-user__name">${escapeHtml(u.name)}</span>
          <span class="dash-user__email">${escapeHtml(u.email)}</span>
        </button>`,
      )
      .join('');

    userList.querySelectorAll<HTMLElement>('.dash-user-card').forEach((card) => {
      card.addEventListener('click', () => {
        const user = users.find((u) => u.id === card.dataset.userId);
        if (user) void selectUser(user);
      });
    });
  }

  // ── Editor ──────────────────────────────────────────────────────────────────

  async function selectUser(user: AdminUser) {
    selectedUser = user;
    userList.querySelectorAll('.dash-user-card').forEach((card) => {
      card.classList.toggle(
        'is-selected',
        (card as HTMLElement).dataset.userId === user.id,
      );
    });

    editor.classList.remove('hidden');
    editorUserInfo.textContent = `${user.name} — ${user.email}`;
    contentArea.value = '';
    contentArea.placeholder = t(uiLocale(), 'dashboard.common.loading');
    contentArea.disabled = true;

    try {
      const data = await fetchJson<{ content: string }>(
        `/api/admin/system-prompt-extension?userId=${encodeURIComponent(user.id)}`,
      );
      contentArea.value = data.content ?? '';
    } catch (err) {
      showStatus(
        statusMsg,
        err instanceof Error
          ? err.message
          : t(uiLocale(), 'dashboard.prompts.failedLoadExtension'),
        'error',
      );
    } finally {
      contentArea.placeholder = t(uiLocale(), 'dashboard.prompts.placeholder');
      contentArea.disabled = false;
      contentArea.focus();
    }
  }

  async function save(content: string, statusKey: string) {
    if (!selectedUser) return;
    const user = selectedUser;

    saveBtn.disabled = true;
    clearBtn.disabled = true;

    try {
      await fetchJson('/api/admin/system-prompt-extension', {
        method: 'PUT',
        body: JSON.stringify({ userId: user.id, content }),
      });
      showStatus(
        statusMsg,
        t(uiLocale(), statusKey, { email: user.email }),
        'success',
      );
      if (!content) contentArea.value = '';
    } catch (err) {
      showStatus(
        statusMsg,
        err instanceof Error
          ? err.message
          : t(uiLocale(), 'dashboard.prompts.failedSave'),
        'error',
      );
    } finally {
      saveBtn.disabled = false;
      clearBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', () => {
    void save(contentArea.value.trim(), 'dashboard.prompts.savedFor');
  });

  clearBtn.addEventListener('click', () => {
    if (!selectedUser) return;
    const confirmMsg = t(uiLocale(), 'dashboard.prompts.confirmRemove', {
      email: selectedUser.email,
    });
    if (!confirm(confirmMsg)) return;
    void save('', 'dashboard.prompts.removedFor');
  });

  searchBtn.addEventListener('click', () => void searchUsers());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void searchUsers();
  });

  // Initial unfiltered load so the picker is usable immediately
  void searchUsers();
}
