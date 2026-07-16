/**
 * Overview tab — ported from chat/'s dashboard overview.ts.
 *
 * Stat cards backed by this app's admin APIs instead of Supabase:
 * user count (GET /api/admin/users), token usage last 30 days
 * (GET /api/admin/usage) and pending memory candidates (GET /api/memory).
 */

import { fetchJson, fetchUsers, formatNumber, formatTokens } from './logic';
import type { UsageResponse } from './charts';

type MemoryResponse = {
  candidates: unknown[];
  approved: unknown[];
};

export async function initOverview(container: HTMLElement): Promise<void> {
  const statsGrid = container.querySelector('.stats-grid') as HTMLElement;

  try {
    const [users, usage, memory] = await Promise.all([
      fetchUsers(),
      fetchJson<UsageResponse>('/api/admin/usage?days=30'),
      fetchJson<MemoryResponse>('/api/memory'),
    ]);

    let input = 0;
    let output = 0;
    for (const d of usage.perDay) {
      input += d.input;
      output += d.output;
    }

    const stats = [
      { label: 'Users', value: formatNumber(users.length) },
      { label: 'Input tokens (30d)', value: formatTokens(input) },
      { label: 'Output tokens (30d)', value: formatTokens(output) },
      { label: 'Total tokens (30d)', value: formatTokens(input + output) },
      {
        label: 'Pending memories',
        value: formatNumber(memory.candidates.length),
      },
    ];

    statsGrid.innerHTML = stats
      .map(
        (s) => `
        <div class="dash-card dash-stat">
          <div class="dash-stat__label">${s.label}</div>
          <div class="dash-stat__value">${s.value}</div>
        </div>`,
      )
      .join('');
  } catch (err) {
    statsGrid.innerHTML = `<div class="dash-card dash-stat dash-stat--error">${
      err instanceof Error ? err.message : 'Failed to load stats'
    }</div>`;
  }
}
