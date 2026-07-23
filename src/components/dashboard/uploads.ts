/**
 * Uploads tab — admin listing of every uploaded file with sortable columns
 * and delete. Sorting is server-side (GET /api/admin/uploads?sort=&dir=).
 */

import { t, uiLocale } from '@/lib/i18n';
import { escapeHtml, fetchJson, formatDateTime, showStatus } from './logic';

type UploadRow = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
  user: string | null;
  chat: string | null;
};

type SortField = 'filename' | 'mime' | 'size' | 'createdAt' | 'user';

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export async function initUploads(container: HTMLElement): Promise<void> {
  const tableBody = container.querySelector('.uploads-table-body') as HTMLElement;
  const statusMsg = container.querySelector('.dash-status') as HTMLElement;

  let sort: SortField = 'createdAt';
  let dir: 'asc' | 'desc' = 'desc';

  const report = (err: unknown, fallback: string) =>
    showStatus(statusMsg, err instanceof Error ? err.message : fallback, 'error');

  function updateHeaders() {
    container.querySelectorAll<HTMLElement>('[data-sort]').forEach((th) => {
      const active = th.dataset.sort === sort;
      th.classList.toggle('is-sorted', active);
      const caret = th.querySelector('.dash-sort-caret');
      if (caret) caret.textContent = active ? (dir === 'asc' ? '▲' : '▼') : '';
    });
  }

  function render(uploads: UploadRow[]) {
    updateHeaders();
    if (uploads.length === 0) {
      tableBody.innerHTML = `<tr><td class="dash-td-muted" colspan="7">${t(uiLocale(), 'dashboard.uploads.none')}</td></tr>`;
      return;
    }
    tableBody.innerHTML = uploads
      .map(
        (u) => `
        <tr>
          <td>${escapeHtml(u.filename)}</td>
          <td class="dash-td-muted">${escapeHtml(u.mime)}</td>
          <td class="dash-num">${formatBytes(u.size)}</td>
          <td class="dash-td-muted">${escapeHtml(formatDateTime(u.createdAt))}</td>
          <td>${escapeHtml(u.user ?? '—')}</td>
          <td>${
            u.chat
              ? escapeHtml(u.chat)
              : `<span class="dash-td-muted">${t(uiLocale(), 'dashboard.uploads.global')}</span>`
          }</td>
          <td>
            <button type="button" class="dash-btn upload-delete" data-id="${escapeHtml(u.id)}" data-name="${escapeHtml(u.filename)}">${t(uiLocale(), 'dashboard.uploads.delete')}</button>
          </td>
        </tr>`,
      )
      .join('');

    tableBody.querySelectorAll<HTMLButtonElement>('.upload-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { id, name } = btn.dataset;
        if (!confirm(t(uiLocale(), 'dashboard.uploads.confirmDelete', { name: name ?? '' }))) return;
        btn.disabled = true;
        try {
          await fetchJson(`/api/admin/uploads?id=${encodeURIComponent(id!)}`, { method: 'DELETE' });
          showStatus(statusMsg, t(uiLocale(), 'dashboard.uploads.deleted'), 'success');
          await load();
        } catch (err) {
          report(err, t(uiLocale(), 'dashboard.uploads.failedDelete'));
          btn.disabled = false;
        }
      });
    });
  }

  async function load() {
    tableBody.innerHTML = `<tr class="animate-pulse"><td class="dash-td-muted" colspan="7">${t(uiLocale(), 'dashboard.common.loadingData')}</td></tr>`;
    try {
      const { uploads } = await fetchJson<{ uploads: UploadRow[] }>(
        `/api/admin/uploads?sort=${sort}&dir=${dir}`,
      );
      render(uploads);
    } catch (err) {
      tableBody.innerHTML = `<tr><td class="dash-td-error" colspan="7">${
        err instanceof Error ? escapeHtml(err.message) : t(uiLocale(), 'dashboard.uploads.failedLoad')
      }</td></tr>`;
    }
  }

  container.querySelectorAll<HTMLElement>('[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort as SortField;
      if (sort === field) {
        dir = dir === 'asc' ? 'desc' : 'asc';
      } else {
        sort = field;
        dir = field === 'createdAt' || field === 'size' ? 'desc' : 'asc';
      }
      void load();
    });
  });

  await load();
}
