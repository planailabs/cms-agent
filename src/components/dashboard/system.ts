/**
 * System tab — running previews, branches, and chats with admin actions
 * (stop/restart/repair previews, delete branches/chats).
 */

import { t, uiLocale } from '@/lib/i18n';
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

type PreviewAction = 'stop' | 'restart' | 'repair';

const TRIGGERED_KEYS: Record<PreviewAction, string> = {
  stop: 'dashboard.system.triggeredStop',
  restart: 'dashboard.system.triggeredRestart',
  repair: 'dashboard.system.triggeredRepair',
};

const FAILED_ACTION_KEYS: Record<PreviewAction, string> = {
  stop: 'dashboard.system.failedStop',
  restart: 'dashboard.system.failedRestart',
  repair: 'dashboard.system.failedRepair',
};

const ACTION_LABEL_KEYS: Record<PreviewAction, string> = {
  stop: 'dashboard.system.stop',
  restart: 'dashboard.system.restart',
  repair: 'dashboard.system.repair',
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
        err instanceof Error
          ? escapeHtml(err.message)
          : t(uiLocale(), 'dashboard.system.failedLoadPreviews')
      }</td></tr>`;
    }
  }

  function renderPreviews(instances: Instance[], errors: StartError[]) {
    const errored = errors.filter((e) => !instances.some((i) => i.branch === e.branch));
    if (instances.length === 0 && errored.length === 0) {
      previewsBody.innerHTML = `<tr><td class="dash-td-muted" colspan="6">${t(uiLocale(), 'dashboard.system.noPreviews')}</td></tr>`;
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
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(i.branch)}" data-action="stop">${t(uiLocale(), 'dashboard.system.stop')}</button>
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(i.branch)}" data-action="restart">${t(uiLocale(), 'dashboard.system.restart')}</button>
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(i.branch)}" data-action="repair">${t(uiLocale(), 'dashboard.system.repair')}</button>
          </td>
        </tr>`,
      ),
      ...errored.map(
        (e) => `
        <tr>
          <td>${escapeHtml(e.branch)}</td>
          <td class="dash-td-error" colspan="4" title="${escapeHtml(e.message)}">${t(
            uiLocale(),
            'dashboard.system.failedPrefix',
            { message: escapeHtml(e.message.split('\n')[0].slice(0, 120)) },
          )}</td>
          <td>
            <button type="button" class="dash-btn preview-action" data-branch="${escapeHtml(e.branch)}" data-action="repair">${t(uiLocale(), 'dashboard.system.repair')}</button>
          </td>
        </tr>`,
      ),
    ].join('');

    previewsBody.querySelectorAll<HTMLButtonElement>('.preview-action').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const { branch } = btn.dataset;
        const action = btn.dataset.action as PreviewAction;
        try {
          await fetchJson('/api/admin/previews', {
            method: 'POST',
            body: JSON.stringify({ branch, action }),
          });
          showStatus(
            statusMsg,
            t(uiLocale(), TRIGGERED_KEYS[action], { branch: branch! }),
            'success',
          );
        } catch (err) {
          report(err, t(uiLocale(), FAILED_ACTION_KEYS[action], { branch: branch! }));
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
        err instanceof Error
          ? escapeHtml(err.message)
          : t(uiLocale(), 'dashboard.system.failedLoadBranches')
      }</td></tr>`;
    }
  }

  function renderBranches(branches: BranchRow[]) {
    if (branches.length === 0) {
      branchesBody.innerHTML = `<tr><td class="dash-td-muted" colspan="7">${t(uiLocale(), 'dashboard.system.noBranches')}</td></tr>`;
      return;
    }
    branchesBody.innerHTML = branches
      .map(
        (b) => `
        <tr>
          <td>${escapeHtml(b.name)}${b.isDefault ? ` <span class="dash-td-muted">${t(uiLocale(), 'dashboard.system.defaultSuffix')}</span>` : ''}</td>
          <td class="dash-td-muted">${escapeHtml(b.createdBy ?? '—')}</td>
          <td class="dash-num">${b.chats}</td>
          <td class="dash-num">${b.publications}</td>
          <td class="dash-td-muted">${
            b.running
              ? t(uiLocale(), 'dashboard.system.stateRunning')
              : b.inGit
                ? t(uiLocale(), 'dashboard.system.stateInGit')
                : t(uiLocale(), 'dashboard.system.stateDbOnly')
          }</td>
          <td class="dash-td-muted">${b.createdAt ? formatDateTime(b.createdAt) : '—'}</td>
          <td>${
            b.isDefault
              ? ''
              : `<button type="button" class="dash-btn branch-delete" data-name="${escapeHtml(b.name)}">${t(uiLocale(), 'dashboard.system.delete')}</button>`
          }</td>
        </tr>`,
      )
      .join('');

    branchesBody.querySelectorAll<HTMLButtonElement>('.branch-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name!;
        if (!confirm(t(uiLocale(), 'dashboard.system.confirmDeleteBranch', { name }))) return;
        btn.disabled = true;
        try {
          await fetchJson(`/api/admin/branches?name=${encodeURIComponent(name)}`, {
            method: 'DELETE',
          });
          showStatus(
            statusMsg,
            t(uiLocale(), 'dashboard.system.branchDeleted', { name }),
            'success',
          );
        } catch (err) {
          report(err, t(uiLocale(), 'dashboard.system.failedDeleteBranch', { name }));
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
        err instanceof Error
          ? escapeHtml(err.message)
          : t(uiLocale(), 'dashboard.system.failedLoadChats')
      }</td></tr>`;
    }
  }

  function renderChats(chats: ChatRow[]) {
    if (chats.length === 0) {
      chatsBody.innerHTML = `<tr><td class="dash-td-muted" colspan="8">${t(uiLocale(), 'dashboard.system.noChats')}</td></tr>`;
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
          <td><button type="button" class="dash-btn chat-delete" data-id="${escapeHtml(c.id)}" data-title="${escapeHtml(c.title)}">${t(uiLocale(), 'dashboard.system.delete')}</button></td>
        </tr>`,
      )
      .join('');

    chatsBody.querySelectorAll<HTMLButtonElement>('.chat-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { id, title } = btn.dataset;
        if (!confirm(t(uiLocale(), 'dashboard.system.confirmDeleteChat', { title: title! }))) return;
        btn.disabled = true;
        try {
          await fetchJson(`/api/admin/chats?id=${encodeURIComponent(id!)}`, { method: 'DELETE' });
          showStatus(
            statusMsg,
            t(uiLocale(), 'dashboard.system.chatDeleted', { title: title! }),
            'success',
          );
        } catch (err) {
          report(err, t(uiLocale(), 'dashboard.system.failedDeleteChat'));
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
