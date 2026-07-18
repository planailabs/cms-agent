/**
 * Memory tab (new) — approve/reject pending memory candidates and revoke
 * approved memories. Backed by GET/POST /api/memory.
 */

import { t, uiLocale } from '@/lib/i18n';
import { escapeHtml, fetchJson, formatDateTime, showStatus } from './logic';

type MemoryCandidate = {
  id: string;
  content: string;
  source: string;
  reason: string;
  createdAt: string;
};

type ApprovedMemory = {
  id: string;
  content: string;
  approvedBy: { name: string } | null;
  createdAt: string;
};

type MemoryResponse = {
  candidates: MemoryCandidate[];
  approved: ApprovedMemory[];
};

export async function initMemory(container: HTMLElement): Promise<void> {
  const pendingList = container.querySelector('.memory-pending') as HTMLElement;
  const approvedList = container.querySelector('.memory-approved') as HTMLElement;
  const statusMsg = container.querySelector('.dash-status') as HTMLElement;

  const STATUS_KEYS = {
    approve: 'dashboard.memory.statusApproved',
    reject: 'dashboard.memory.statusRejected',
    revoke: 'dashboard.memory.statusRevoked',
  } as const;

  const FAILED_KEYS = {
    approve: 'dashboard.memory.failedApprove',
    reject: 'dashboard.memory.failedReject',
    revoke: 'dashboard.memory.failedRevoke',
  } as const;

  async function decide(id: string, action: 'approve' | 'reject' | 'revoke') {
    await fetchJson('/api/memory', {
      method: 'POST',
      body: JSON.stringify({ id, action }),
    });
  }

  async function load() {
    const loading = `<div class="dash-td-muted animate-pulse">${t(uiLocale(), 'dashboard.common.loading')}</div>`;
    pendingList.innerHTML = loading;
    approvedList.innerHTML = loading;

    try {
      const data = await fetchJson<MemoryResponse>('/api/memory');
      renderPending(data.candidates ?? []);
      renderApproved(data.approved ?? []);
    } catch (err) {
      const msg = `<div class="dash-td-error">${
        err instanceof Error
          ? escapeHtml(err.message)
          : t(uiLocale(), 'dashboard.memory.failedLoad')
      }</div>`;
      pendingList.innerHTML = msg;
      approvedList.innerHTML = msg;
    }
  }

  function bindDecisionButtons(
    root: HTMLElement,
    action: 'approve' | 'reject' | 'revoke',
    selector: string,
    confirmMsg?: string,
  ) {
    root.querySelectorAll<HTMLButtonElement>(selector).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (confirmMsg && !confirm(confirmMsg)) return;
        btn.disabled = true;
        try {
          await decide(btn.dataset.id!, action);
          showStatus(statusMsg, t(uiLocale(), STATUS_KEYS[action]), 'success');
          await load();
        } catch (err) {
          btn.disabled = false;
          showStatus(
            statusMsg,
            err instanceof Error
              ? err.message
              : t(uiLocale(), FAILED_KEYS[action]),
            'error',
          );
        }
      });
    });
  }

  function renderPending(candidates: MemoryCandidate[]) {
    if (candidates.length === 0) {
      pendingList.innerHTML = `<div class="dash-td-muted">${t(uiLocale(), 'dashboard.memory.noPending')}</div>`;
      return;
    }

    pendingList.innerHTML = candidates
      .map(
        (c) => `
        <div class="dash-card dash-memory">
          <div class="dash-memory__content">${escapeHtml(c.content)}</div>
          <div class="dash-memory__meta">
            <span class="dash-badge dash-badge--accent">${escapeHtml(c.source)}</span>
            <span>${escapeHtml(c.reason)}</span>
            <span class="dash-td-muted">${formatDateTime(c.createdAt)}</span>
          </div>
          <div class="dash-memory__actions">
            <button type="button" class="dash-btn dash-btn--ok approve-btn" data-id="${escapeHtml(c.id)}">${t(uiLocale(), 'dashboard.memory.approve')}</button>
            <button type="button" class="dash-btn dash-btn--danger reject-btn" data-id="${escapeHtml(c.id)}">${t(uiLocale(), 'dashboard.memory.reject')}</button>
          </div>
        </div>`,
      )
      .join('');

    bindDecisionButtons(pendingList, 'approve', '.approve-btn');
    bindDecisionButtons(pendingList, 'reject', '.reject-btn');
  }

  function renderApproved(approved: ApprovedMemory[]) {
    if (approved.length === 0) {
      approvedList.innerHTML = `<div class="dash-td-muted">${t(uiLocale(), 'dashboard.memory.noApproved')}</div>`;
      return;
    }

    approvedList.innerHTML = approved
      .map(
        (m) => `
        <div class="dash-card dash-memory">
          <div class="dash-memory__content">${escapeHtml(m.content)}</div>
          <div class="dash-memory__meta">
            <span>${t(uiLocale(), 'dashboard.memory.approvedBy', {
              name: escapeHtml(
                m.approvedBy?.name ??
                  t(uiLocale(), 'dashboard.memory.unknownApprover'),
              ),
            })}</span>
            <span class="dash-td-muted">${formatDateTime(m.createdAt)}</span>
          </div>
          <div class="dash-memory__actions">
            <button type="button" class="dash-btn dash-btn--danger revoke-btn" data-id="${escapeHtml(m.id)}">${t(uiLocale(), 'dashboard.memory.revoke')}</button>
          </div>
        </div>`,
      )
      .join('');

    bindDecisionButtons(
      approvedList,
      'revoke',
      '.revoke-btn',
      t(uiLocale(), 'dashboard.memory.confirmRevoke'),
    );
  }

  await load();
}
