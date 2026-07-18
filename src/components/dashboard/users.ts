/**
 * Users tab — search + role management.
 *
 * GET /api/admin/users?q=… lists users; each row has a role select
 * (admin/editor) wired to POST /api/admin/users { userId, role }.
 */

import { t, uiLocale } from '@/lib/i18n';
import {
  escapeHtml,
  fetchJson,
  fetchUsers,
  formatDate,
  showStatus,
  type AdminUser,
} from './logic';

const ROLES = ['admin', 'editor'] as const;

/** Localized display label for a role value (falls back to the raw value). */
const roleLabel = (role: string): string => {
  if (role === 'admin') return t(uiLocale(), 'dashboard.users.roleAdmin');
  if (role === 'editor') return t(uiLocale(), 'dashboard.users.roleEditor');
  return role;
};

export async function initUsers(container: HTMLElement): Promise<void> {
  const searchInput = container.querySelector('.search-input') as HTMLInputElement;
  const searchBtn = container.querySelector('.search-btn') as HTMLButtonElement;
  const tableBody = container.querySelector('.users-table-body') as HTMLElement;
  const statusMsg = container.querySelector('.dash-status') as HTMLElement;

  async function search() {
    const q = searchInput.value.trim();
    searchBtn.textContent = t(uiLocale(), 'dashboard.common.searching');
    searchBtn.disabled = true;
    tableBody.innerHTML = `<tr class="animate-pulse"><td class="dash-td-muted" colspan="5">${t(uiLocale(), 'dashboard.common.loadingUsers')}</td></tr>`;

    try {
      renderUsers(await fetchUsers(q || undefined));
    } catch (err) {
      tableBody.innerHTML = `<tr><td class="dash-td-error" colspan="5">${
        err instanceof Error
          ? escapeHtml(err.message)
          : t(uiLocale(), 'dashboard.common.failedLoadUsers')
      }</td></tr>`;
    } finally {
      searchBtn.textContent = t(uiLocale(), 'dashboard.common.search');
      searchBtn.disabled = false;
    }
  }

  function renderUsers(users: AdminUser[]) {
    if (users.length === 0) {
      tableBody.innerHTML = `<tr><td class="dash-td-muted" colspan="5">${t(uiLocale(), 'dashboard.common.noUsersFound')}</td></tr>`;
      return;
    }

    tableBody.innerHTML = users
      .map(
        (u) => `
        <tr>
          <td>${escapeHtml(u.email)}</td>
          <td>${escapeHtml(u.name)}</td>
          <td>
            <select class="dash-input role-select" data-user-id="${escapeHtml(u.id)}" data-email="${escapeHtml(u.email)}">
              ${ROLES.map(
                (r) =>
                  `<option value="${r}" ${u.role === r ? 'selected' : ''}>${escapeHtml(roleLabel(r))}</option>`,
              ).join('')}
            </select>
          </td>
          <td class="dash-td-muted">${escapeHtml(u.language ?? '—')}</td>
          <td class="dash-td-muted">${formatDate(u.createdAt)}</td>
        </tr>`,
      )
      .join('');

    tableBody.querySelectorAll<HTMLSelectElement>('.role-select').forEach((select) => {
      const previousRole = select.value;
      select.dataset.prevRole = previousRole;

      select.addEventListener('change', async () => {
        const userId = select.dataset.userId!;
        const email = select.dataset.email!;
        const role = select.value;
        select.disabled = true;

        try {
          await fetchJson('/api/admin/users', {
            method: 'POST',
            body: JSON.stringify({ userId, role }),
          });
          select.dataset.prevRole = role;
          showStatus(
            statusMsg,
            t(uiLocale(), 'dashboard.users.roleSet', {
              email,
              role: roleLabel(role),
            }),
            'success',
          );
        } catch (err) {
          select.value = select.dataset.prevRole ?? 'editor';
          showStatus(
            statusMsg,
            err instanceof Error
              ? err.message
              : t(uiLocale(), 'dashboard.users.failedUpdateRole'),
            'error',
          );
        } finally {
          select.disabled = false;
        }
      });
    });
  }

  searchBtn.addEventListener('click', () => void search());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void search();
  });

  // Initial unfiltered load
  await search();
}
