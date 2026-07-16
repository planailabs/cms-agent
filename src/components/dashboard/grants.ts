/**
 * Grants tab (new) — autonomy grants management.
 *
 * GET /api/admin/grants lists grants; POST creates; DELETE ?id= revokes.
 * Executions are budgeted by decrementing maxExecutions server-side, so the
 * stored value is the number of executions left.
 */

import {
  escapeHtml,
  fetchJson,
  fetchUsers,
  formatDateTime,
  showStatus,
} from './logic';

type Grant = {
  id: string;
  userId: string | null;
  user: { email: string } | null;
  createdBy: { name: string };
  actions: string[];
  pathScope: string[];
  maxRisk: string;
  maxExecutions: number;
  validFrom: string;
  validUntil: string;
  onError: string;
  createdAt: string;
  revokedAt: string | null;
};

function grantStatus(g: Grant): { label: string; cls: string } {
  if (g.revokedAt) return { label: 'Revoked', cls: 'dash-badge--danger' };
  if (new Date(g.validUntil).getTime() < Date.now())
    return { label: 'Expired', cls: 'dash-badge--muted' };
  if (g.maxExecutions <= 0)
    return { label: 'Exhausted', cls: 'dash-badge--muted' };
  return { label: 'Active', cls: 'dash-badge--ok' };
}

export async function initGrants(container: HTMLElement): Promise<void> {
  const tableBody = container.querySelector('.grants-table-body') as HTMLElement;
  const statusMsg = container.querySelector('.dash-status') as HTMLElement;
  const form = container.querySelector('.grant-form') as HTMLElement;
  const userSelect = form.querySelector('.grant-user') as HTMLSelectElement;
  const riskSelect = form.querySelector('.grant-risk') as HTMLSelectElement;
  const execInput = form.querySelector('.grant-executions') as HTMLInputElement;
  const untilInput = form.querySelector('.grant-until') as HTMLInputElement;
  const onErrorSelect = form.querySelector('.grant-onerror') as HTMLSelectElement;
  const scopeArea = form.querySelector('.grant-scope') as HTMLTextAreaElement;
  const createBtn = form.querySelector('.grant-create-btn') as HTMLButtonElement;

  // Default validity: one week from now (local time, minute precision)
  const inWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  inWeek.setMinutes(inWeek.getMinutes() - inWeek.getTimezoneOffset());
  untilInput.value = inWeek.toISOString().slice(0, 16);

  // Populate user picker (empty value = grant applies to all users)
  try {
    const users = await fetchUsers();
    userSelect.innerHTML =
      '<option value="">All users</option>' +
      users
        .map(
          (u) =>
            `<option value="${escapeHtml(u.id)}">${escapeHtml(u.email)}</option>`,
        )
        .join('');
  } catch {
    userSelect.innerHTML = '<option value="">All users</option>';
  }

  async function loadGrants() {
    tableBody.innerHTML =
      '<tr class="animate-pulse"><td class="dash-td-muted" colspan="8">Loading grants...</td></tr>';

    try {
      const data = await fetchJson<{ grants: Grant[] }>('/api/admin/grants');
      renderGrants(data.grants ?? []);
    } catch (err) {
      tableBody.innerHTML = `<tr><td class="dash-td-error" colspan="8">${
        err instanceof Error ? escapeHtml(err.message) : 'Failed to load grants'
      }</td></tr>`;
    }
  }

  function renderGrants(grants: Grant[]) {
    if (grants.length === 0) {
      tableBody.innerHTML =
        '<tr><td class="dash-td-muted" colspan="8">No grants yet</td></tr>';
      return;
    }

    tableBody.innerHTML = grants
      .map((g) => {
        const status = grantStatus(g);
        const active = status.label === 'Active';
        return `
        <tr>
          <td>${g.user ? escapeHtml(g.user.email) : '<span class="dash-td-muted">All users</span>'}</td>
          <td>${g.actions.map((a) => `<span class="dash-badge dash-badge--accent">${escapeHtml(a)}</span>`).join(' ')}</td>
          <td class="dash-mono">${g.pathScope.map((p) => escapeHtml(p)).join('<br>')}</td>
          <td>${escapeHtml(g.maxRisk)}</td>
          <td class="dash-num">${g.maxExecutions}</td>
          <td class="dash-td-muted">${formatDateTime(g.validUntil)}</td>
          <td><span class="dash-badge ${status.cls}">${status.label}</span></td>
          <td>${
            active
              ? `<button type="button" class="dash-btn dash-btn--danger revoke-grant-btn" data-grant-id="${escapeHtml(g.id)}">Revoke</button>`
              : ''
          }</td>
        </tr>`;
      })
      .join('');

    tableBody.querySelectorAll<HTMLButtonElement>('.revoke-grant-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this grant?')) return;
        btn.disabled = true;
        btn.textContent = 'Revoking...';
        try {
          await fetchJson(
            `/api/admin/grants?id=${encodeURIComponent(btn.dataset.grantId!)}`,
            { method: 'DELETE' },
          );
          showStatus(statusMsg, 'Grant revoked', 'success');
          await loadGrants();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Revoke';
          showStatus(
            statusMsg,
            err instanceof Error ? err.message : 'Failed to revoke grant',
            'error',
          );
        }
      });
    });
  }

  createBtn.addEventListener('click', async () => {
    const actions = [
      ...form.querySelectorAll<HTMLInputElement>('.grant-action:checked'),
    ].map((cb) => cb.value);
    const pathScope = scopeArea.value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (actions.length === 0) {
      showStatus(statusMsg, 'Select at least one action', 'error');
      return;
    }
    if (pathScope.length === 0) {
      showStatus(statusMsg, 'Add at least one path glob', 'error');
      return;
    }
    if (!untilInput.value) {
      showStatus(statusMsg, 'Set a valid-until date', 'error');
      return;
    }

    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';

    try {
      await fetchJson('/api/admin/grants', {
        method: 'POST',
        body: JSON.stringify({
          userId: userSelect.value || null,
          actions,
          pathScope,
          maxRisk: riskSelect.value,
          maxExecutions: Math.max(1, parseInt(execInput.value, 10) || 1),
          validUntil: new Date(untilInput.value).toISOString(),
          onError: onErrorSelect.value,
        }),
      });
      showStatus(statusMsg, 'Grant created', 'success');
      scopeArea.value = '';
      await loadGrants();
    } catch (err) {
      showStatus(
        statusMsg,
        err instanceof Error ? err.message : 'Failed to create grant',
        'error',
      );
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Create grant';
    }
  });

  await loadGrants();
}
