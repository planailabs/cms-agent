/**
 * Tokens tab — token usage from GET /api/admin/usage.
 *
 * Replaces chat/'s customer-token tab (dropped) with the usage view:
 * per-day stacked input/output ApexCharts chart + per-user totals table.
 */

import { escapeHtml, fetchJson, formatNumber } from './logic';
import { renderUsageChart, type UsageResponse } from './charts';

export async function initTokens(container: HTMLElement): Promise<void> {
  const chartEl = container.querySelector('.usage-chart') as HTMLElement;
  const tableBody = container.querySelector('.usage-table-body') as HTMLElement;
  const daysSelect = container.querySelector('.days-select') as HTMLSelectElement;

  async function load(days: number) {
    tableBody.innerHTML =
      '<tr class="animate-pulse"><td class="dash-td-muted" colspan="4">Loading usage...</td></tr>';

    try {
      const usage = await fetchJson<UsageResponse>(
        `/api/admin/usage?days=${days}`,
      );

      renderUsageChart(chartEl, usage.perDay);

      const perUser = [...usage.perUser].sort(
        (a, b) => b.input + b.output - (a.input + a.output),
      );

      if (perUser.length === 0) {
        tableBody.innerHTML =
          '<tr><td class="dash-td-muted" colspan="4">No usage recorded in this period</td></tr>';
        return;
      }

      tableBody.innerHTML = perUser
        .map(
          (u) => `
          <tr>
            <td>
              <div class="dash-user">
                <span class="dash-user__name">${escapeHtml(u.name)}</span>
                <span class="dash-user__email">${escapeHtml(u.email)}</span>
              </div>
            </td>
            <td class="dash-num">${formatNumber(u.input)}</td>
            <td class="dash-num">${formatNumber(u.output)}</td>
            <td class="dash-num">${formatNumber(u.input + u.output)}</td>
          </tr>`,
        )
        .join('');
    } catch (err) {
      tableBody.innerHTML = `<tr><td class="dash-td-error" colspan="4">${
        err instanceof Error ? escapeHtml(err.message) : 'Failed to load usage'
      }</td></tr>`;
    }
  }

  daysSelect.addEventListener('change', () => {
    void load(parseInt(daysSelect.value, 10));
  });

  await load(parseInt(daysSelect.value, 10));
}
