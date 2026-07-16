/**
 * System Prompts tab — ported from chat/'s dashboard prompts.ts.
 *
 * User picker (search backed by GET /api/admin/users) + inline textarea
 * editor for the per-user system prompt extension. Chat modes are gone in
 * this app, so there is a single extension per user:
 * GET /api/admin/system-prompt-extension?userId=… / PUT { userId, content }
 * (empty content deletes the extension).
 */

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
    searchBtn.textContent = 'Searching...';
    searchBtn.disabled = true;
    userList.innerHTML =
      '<div class="dash-td-muted animate-pulse">Loading users...</div>';

    try {
      renderUsers(await fetchUsers(q || undefined));
    } catch (err) {
      userList.innerHTML = `<div class="dash-td-error">${
        err instanceof Error ? escapeHtml(err.message) : 'Failed to load users'
      }</div>`;
    } finally {
      searchBtn.textContent = 'Search';
      searchBtn.disabled = false;
    }
  }

  function renderUsers(users: AdminUser[]) {
    if (users.length === 0) {
      userList.innerHTML = '<div class="dash-td-muted">No users found</div>';
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
    contentArea.placeholder = 'Loading...';
    contentArea.disabled = true;

    try {
      const data = await fetchJson<{ content: string }>(
        `/api/admin/system-prompt-extension?userId=${encodeURIComponent(user.id)}`,
      );
      contentArea.value = data.content ?? '';
    } catch (err) {
      showStatus(
        statusMsg,
        err instanceof Error ? err.message : 'Failed to load extension',
        'error',
      );
    } finally {
      contentArea.placeholder =
        'Additional system prompt instructions for this user...';
      contentArea.disabled = false;
      contentArea.focus();
    }
  }

  async function save(content: string, label: string) {
    if (!selectedUser) return;
    const user = selectedUser;

    saveBtn.disabled = true;
    clearBtn.disabled = true;

    try {
      await fetchJson('/api/admin/system-prompt-extension', {
        method: 'PUT',
        body: JSON.stringify({ userId: user.id, content }),
      });
      showStatus(statusMsg, `${label} for ${user.email}`, 'success');
      if (!content) contentArea.value = '';
    } catch (err) {
      showStatus(
        statusMsg,
        err instanceof Error ? err.message : 'Failed to save',
        'error',
      );
    } finally {
      saveBtn.disabled = false;
      clearBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', () => {
    void save(contentArea.value.trim(), 'Prompt extension saved');
  });

  clearBtn.addEventListener('click', () => {
    if (!selectedUser) return;
    if (!confirm(`Remove prompt extension for ${selectedUser.email}?`)) return;
    void save('', 'Prompt extension removed');
  });

  searchBtn.addEventListener('click', () => void searchUsers());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void searchUsers();
  });

  // Initial unfiltered load so the picker is usable immediately
  void searchUsers();
}
