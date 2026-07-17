/**
 * System tab — running previews, branches, and chats with admin actions
 * (stop/restart/repair previews, delete branches/chats).
 */

import { escapeHtml, fetchJson, formatDateTime, showStatus } from './logic';

type Instance = {
  branch: string;
  port: number;
  pid: number;
  startedAt: number;
  lastUsedAt: number;
  status: string;
};
type StartError = { branch: string; message: string; at: number };
type BranchRow = {
  name: string;
  createdBy: string | null;
  createdAt: string | null;
  chats: number;
  publications: number;
  inGit: boolean;
  running: boolean;
  isDefault: boolean;
};
type ChatRow = {
  id: string;
  title: string;
  kind: string;
  workflowPhase: string;
  branch: string;
  workBranch: string;
  createdBy: string | null;
  messages: number;
  createdAt: string;
};

export async function initSystem(container: HTMLElement): Promise<void> {
  const statusMsg = container.querySelector('.dash-status') as HTMLElement;
  const previewsBody = container.querySelector('.previews-table-body') as HTMLElement;
  const branchesBody = container.querySelector('.branches-table-body') as HTMLElement;
  const chatsBody = container.querySelector('.chats-table-body') as HTMLElement;

  const report = (err: unknown, fallback: string) =>
    showStatus(statusMsg, err instanceof Error ? err.message : fallback, 'error');

  async function loadPreviews() {
    try {
      const { instances, errors } = await fetchJson<{
        instances: Instance[];
        errors: StartError[];
      }>('/api/admin/previews');
      renderPreviews(instances, errors);
    } catch (err) {
      previewsBody.innerHTML = `<tr><td class="dash-td-error" colspan="6">${
        err instanceof Error ? escapeHtml(err.message) : 'Failed to load previews'
      }</td></tr>`;
    }
  }

  function renderPreviews(instances: Instance[], errors: StartError[]) {
    const errored = errors.filter((e) => !instances.some((i) => i.branch === e.branch));
    if (instances.length === 0 && errored.length === 0) {
      previewsBody.innerHTML =
        '<tr><td class="dash-td-muted" colspan="6">No running previews</td></tr>';
      return;
    }
    previewsBody.innerHTML = [
      ...instances.map(
        (i) => `
        <tr>
          <td>${escapeHtml(i.branch)}</td>
          <td>${escapeHtml(i.status)}</td>
          <td class="dash-td-muted">${i.port} / ${i.pid}</td>
          <td class="dash-td-muted">${formatDateTime(new Date(i.startedAt).toISOString())}</td>
          <td class="dash-td-muted">${formatDateTime(new Date(i.lastUsedAt).toISOString())}</td>
          <td>
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(i.branch)}" data-action="stop">Stop</button>
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(i.branch)}" data-action="restart">Restart</button>
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(i.branch)}" data-action="repair">Repair</button>
          </td>
        </tr>`,
      ),
      ...errored.map(
        (e) => `
        <tr>
          <td>${escapeHtml(e.branch)}</td>
          <td class="dash-td-error" colspan="4" title="${escapeHtml(e.message)}">failed: ${escapeHtml(e.message.split('\n')[0].slice(0, 120))}</td>
          <td>
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(e.branch)}" data-action="repair">Repair</button>
          </td>
        </tr>`,
      ),
    ].join('');

    previewsBody.querySelectorAll<HTMLButtonElement>('.preview-action').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const { branch, action } = btn.dataset;
        try {
          await fetchJson('/api/admin/previews', {
            method: 'POST',
            body: JSON.stringify({ branch, action }),
          });
          showStatus(statusMsg, `${action} of ${branch} triggered`, 'success');
        } catch (err) {
          report(err, `Failed to ${action} ${branch}`);
        }
        await loadPreviews();
      });
    });
  }

  async function loadBranches() {
    try {
      const { branches } = await fetchJson<{ branches: BranchRow[] }>('/api/admin/branches');
      renderBranches(branches);
    } catch (err) {
      branchesBody.innerHTML = `<tr><td class="dash-td-error" colspan="7">${
        err instanceof Error ? escapeHtml(err.message) : 'Failed to load branches'
      }</td></tr>`;
    }
  }

  function renderBranches(branches: BranchRow[]) {
    if (branches.length === 0) {
      branchesBody.innerHTML = '<tr><td class="dash-td-muted" colspan="7">No branches</td></tr>';
      return;
    }
    branchesBody.innerHTML = branches
      .map(
        (b) => `
        <tr>
          <td>${escapeHtml(b.name)}${b.isDefault ? ' <span class="dash-td-muted">(default)</span>' : ''}</td>
          <td class="dash-td-muted">${escapeHtml(b.createdBy ?? '—')}</td>
          <td class="dash-num">${b.chats}</td>
          <td class="dash-num">${b.publications}</td>
          <td class="dash-td-muted">${b.running ? 'running' : b.inGit ? 'in git' : 'db only'}</td>
          <td class="dash-td-muted">${b.createdAt ? formatDateTime(b.createdAt) : '—'}</td>
          <td>${
            b.isDefault
              ? ''
              : `<button type="button" class="dash-btn branch-delete" data-name="${escapeHtml(b.name)}">Delete</button>`
          }</td>
        </tr>`,
      )
      .join('');

    branchesBody.querySelectorAll<HTMLButtonElement>('.branch-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name!;
        if (!confirm(`Delete branch "${name}" including its chats, previews and git ref?`)) return;
        btn.disabled = true;
        try {
          await fetchJson(`/api/admin/branches?name=${encodeURIComponent(name)}`, {
            method: 'DELETE',
          });
          showStatus(statusMsg, `Branch ${name} deleted`, 'success');
        } catch (err) {
          report(err, `Failed to delete ${name}`);
        }
        await Promise.all([loadBranches(), loadChats(), loadPreviews()]);
      });
    });
  }

  async function loadChats() {
    try {
      const { chats } = await fetchJson<{ chats: ChatRow[] }>('/api/admin/chats');
      renderChats(chats);
    } catch (err) {
      chatsBody.innerHTML = `<tr><td class="dash-td-error" colspan="8">${
        err instanceof Error ? escapeHtml(err.message) : 'Failed to load chats'
      }</td></tr>`;
    }
  }

  function renderChats(chats: ChatRow[]) {
    if (chats.length === 0) {
      chatsBody.innerHTML = '<tr><td class="dash-td-muted" colspan="8">No chats</td></tr>';
      return;
    }
    chatsBody.innerHTML = chats
      .map(
        (c) => `
        <tr>
          <td>${escapeHtml(c.title)}</td>
          <td class="dash-td-muted">${escapeHtml(c.kind)}</td>
          <td class="dash-td-muted">${escapeHtml(c.workflowPhase)}</td>
          <td class="dash-td-muted">${escapeHtml(c.branch)} ← ${escapeHtml(c.workBranch)}</td>
          <td class="dash-td-muted">${escapeHtml(c.createdBy ?? '—')}</td>
          <td class="dash-num">${c.messages}</td>
          <td class="dash-td-muted">${formatDateTime(c.createdAt)}</td>
          <td><button type="button" class="dash-btn chat-delete" data-id="${escapeHtml(c.id)}" data-title="${escapeHtml(c.title)}">Delete</button></td>
        </tr>`,
      )
      .join('');

    chatsBody.querySelectorAll<HTMLButtonElement>('.chat-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { id, title } = btn.dataset;
        if (!confirm(`Delete chat "${title}" including its work branch and preview?`)) return;
        btn.disabled = true;
        try {
          await fetchJson(`/api/admin/chats?id=${encodeURIComponent(id!)}`, { method: 'DELETE' });
          showStatus(statusMsg, `Chat "${title}" deleted`, 'success');
        } catch (err) {
          report(err, 'Failed to delete chat');
        }
        await Promise.all([loadChats(), loadBranches(), loadPreviews()]);
      });
    });
  }

  container.querySelector('.system-refresh')?.addEventListener('click', () => {
    void Promise.all([loadPreviews(), loadBranches(), loadChats()]);
  });

  await Promise.all([loadPreviews(), loadBranches(), loadChats()]);
}
