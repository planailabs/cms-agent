/**
 * Grants tab (new) — autonomy grants management.
 *
 * GET /api/admin/grants lists grants; POST creates; DELETE ?id= revokes.
 * Executions are budgeted by decrementing maxExecutions server-side, so the
 * stored value is the number of executions left.
 */

import { t, uiLocale } from '@/lib/i18n';
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

function grantStatus(g: Grant): { labelKey: string; cls: string; active: boolean } {
  if (g.revokedAt)
    return { labelKey: 'dashboard.grants.statusRevoked', cls: 'dash-badge--danger', active: false };
  if (new Date(g.validUntil).getTime() < Date.now())
    return { labelKey: 'dashboard.grants.statusExpired', cls: 'dash-badge--muted', active: false };
  if (g.maxExecutions <= 0)
    return { labelKey: 'dashboard.grants.statusExhausted', cls: 'dash-badge--muted', active: false };
  return { labelKey: 'dashboard.grants.statusActive', cls: 'dash-badge--ok', active: true };
}

/** Localized label for a grant action value (falls back to the raw value). */
const actionLabel = (action: string): string => {
  if (action === 'implement') return t(uiLocale(), 'dashboard.grants.actionImplement');
  if (action === 'publish') return t(uiLocale(), 'dashboard.grants.actionPublish');
  return action;
};

/** Localized label for a max-risk value (falls back to the raw value). */
const riskLabel = (risk: string): string => {
  const keys: Record<string, string> = {
    content: 'dashboard.grants.riskContent',
    template: 'dashboard.grants.riskTemplate',
    code: 'dashboard.grants.riskCode',
    dependency: 'dashboard.grants.riskDependency',
  };
  return keys[risk] ? t(uiLocale(), keys[risk]) : risk;
};

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
  const allUsersOption = () =>
    `<option value="">${t(uiLocale(), 'dashboard.grants.allUsers')}</option>`;
  try {
    const users = await fetchUsers();
    userSelect.innerHTML =
      allUsersOption() +
      users
        .map(
          (u) =>
            `<option value="${escapeHtml(u.id)}">${escapeHtml(u.email)}</option>`,
        )
        .join('');
  } catch {
    userSelect.innerHTML = allUsersOption();
  }

  async function loadGrants() {
    tableBody.innerHTML = `<tr class="animate-pulse"><td class="dash-td-muted" colspan="8">${t(uiLocale(), 'dashboard.grants.loadingGrants')}</td></tr>`;

    try {
      const data = await fetchJson<{ grants: Grant[] }>('/api/admin/grants');
      renderGrants(data.grants ?? []);
    } catch (err) {
      tableBody.innerHTML = `<tr><td class="dash-td-error" colspan="8">${
        err instanceof Error
          ? escapeHtml(err.message)
          : t(uiLocale(), 'dashboard.grants.failedLoad')
      }</td></tr>`;
    }
  }

  function renderGrants(grants: Grant[]) {
    if (grants.length === 0) {
      tableBody.innerHTML = `<tr><td class="dash-td-muted" colspan="8">${t(uiLocale(), 'dashboard.grants.noGrants')}</td></tr>`;
      return;
    }

    tableBody.innerHTML = grants
      .map((g) => {
        const status = grantStatus(g);
        return `
        <tr>
          <td>${g.user ? escapeHtml(g.user.email) : `<span class="dash-td-muted">${t(uiLocale(), 'dashboard.grants.allUsers')}</span>`}</td>
          <td>${g.actions.map((a) => `<span class="dash-badge dash-badge--accent">${escapeHtml(actionLabel(a))}</span>`).join(' ')}</td>
          <td class="dash-mono">${g.pathScope.map((p) => escapeHtml(p)).join('<br>')}</td>
          <td>${escapeHtml(riskLabel(g.maxRisk))}</td>
          <td class="dash-num">${g.maxExecutions}</td>
          <td class="dash-td-muted">${formatDateTime(g.validUntil)}</td>
          <td><span class="dash-badge ${status.cls}">${t(uiLocale(), status.labelKey)}</span></td>
          <td>${
            status.active
              ? `<button type="button" class="dash-btn dash-btn--danger revoke-grant-btn" data-grant-id="${escapeHtml(g.id)}">${t(uiLocale(), 'dashboard.grants.revoke')}</button>`
              : ''
          }</td>
        </tr>`;
      })
      .join('');

    tableBody.querySelectorAll<HTMLButtonElement>('.revoke-grant-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(t(uiLocale(), 'dashboard.grants.confirmRevoke'))) return;
        btn.disabled = true;
        btn.textContent = t(uiLocale(), 'dashboard.grants.revoking');
        try {
          await fetchJson(
            `/api/admin/grants?id=${encodeURIComponent(btn.dataset.grantId!)}`,
            { method: 'DELETE' },
          );
          showStatus(statusMsg, t(uiLocale(), 'dashboard.grants.revoked'), 'success');
          await loadGrants();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = t(uiLocale(), 'dashboard.grants.revoke');
          showStatus(
            statusMsg,
            err instanceof Error
              ? err.message
              : t(uiLocale(), 'dashboard.grants.failedRevoke'),
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
      showStatus(statusMsg, t(uiLocale(), 'dashboard.grants.errNoAction'), 'error');
      return;
    }
    if (pathScope.length === 0) {
      showStatus(statusMsg, t(uiLocale(), 'dashboard.grants.errNoScope'), 'error');
      return;
    }
    if (!untilInput.value) {
      showStatus(statusMsg, t(uiLocale(), 'dashboard.grants.errNoUntil'), 'error');
      return;
    }

    createBtn.disabled = true;
    createBtn.textContent = t(uiLocale(), 'dashboard.grants.creating');

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
      showStatus(statusMsg, t(uiLocale(), 'dashboard.grants.created'), 'success');
      scopeArea.value = '';
      await loadGrants();
    } catch (err) {
      showStatus(
        statusMsg,
        err instanceof Error
          ? err.message
          : t(uiLocale(), 'dashboard.grants.failedCreate'),
        'error',
      );
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = t(uiLocale(), 'dashboard.grants.create');
    }
  });

  await loadGrants();
}
