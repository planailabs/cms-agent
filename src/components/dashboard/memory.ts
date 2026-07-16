/**
 * Memory tab (new) — approve/reject pending memory candidates and revoke
 * approved memories. Backed by GET/POST /api/memory.
 */

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

  const PAST_TENSE = {
    approve: 'approved',
    reject: 'rejected',
    revoke: 'revoked',
  } as const;

  async function decide(id: string, action: 'approve' | 'reject' | 'revoke') {
    await fetchJson('/api/memory', {
      method: 'POST',
      body: JSON.stringify({ id, action }),
    });
  }

  async function load() {
    pendingList.innerHTML =
      '<div class="dash-td-muted animate-pulse">Loading...</div>';
    approvedList.innerHTML =
      '<div class="dash-td-muted animate-pulse">Loading...</div>';

    try {
      const data = await fetchJson<MemoryResponse>('/api/memory');
      renderPending(data.candidates ?? []);
      renderApproved(data.approved ?? []);
    } catch (err) {
      const msg = `<div class="dash-td-error">${
        err instanceof Error ? escapeHtml(err.message) : 'Failed to load memories'
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
          showStatus(statusMsg, `Memory ${PAST_TENSE[action]}`, 'success');
          await load();
        } catch (err) {
          btn.disabled = false;
          showStatus(
            statusMsg,
            err instanceof Error ? err.message : `Failed to ${action}`,
            'error',
          );
        }
      });
    });
  }

  function renderPending(candidates: MemoryCandidate[]) {
    if (candidates.length === 0) {
      pendingList.innerHTML =
        '<div class="dash-td-muted">No pending candidates</div>';
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
            <button type="button" class="dash-btn dash-btn--ok approve-btn" data-id="${escapeHtml(c.id)}">Approve</button>
            <button type="button" class="dash-btn dash-btn--danger reject-btn" data-id="${escapeHtml(c.id)}">Reject</button>
          </div>
        </div>`,
      )
      .join('');

    bindDecisionButtons(pendingList, 'approve', '.approve-btn');
    bindDecisionButtons(pendingList, 'reject', '.reject-btn');
  }

  function renderApproved(approved: ApprovedMemory[]) {
    if (approved.length === 0) {
      approvedList.innerHTML =
        '<div class="dash-td-muted">No approved memories</div>';
      return;
    }

    approvedList.innerHTML = approved
      .map(
        (m) => `
        <div class="dash-card dash-memory">
          <div class="dash-memory__content">${escapeHtml(m.content)}</div>
          <div class="dash-memory__meta">
            <span>Approved by ${escapeHtml(m.approvedBy?.name ?? 'unknown')}</span>
            <span class="dash-td-muted">${formatDateTime(m.createdAt)}</span>
          </div>
          <div class="dash-memory__actions">
            <button type="button" class="dash-btn dash-btn--danger revoke-btn" data-id="${escapeHtml(m.id)}">Revoke</button>
          </div>
        </div>`,
      )
      .join('');

    bindDecisionButtons(
      approvedList,
      'revoke',
      '.revoke-btn',
      'Revoke this memory? The agent will stop using it.',
    );
  }

  await load();
}
