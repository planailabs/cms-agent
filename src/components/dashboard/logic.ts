/**
 * Dashboard shared logic — fetch helper, formatting, status messages.
 *
 * Ported from chat/'s dashboard logic.ts, with the Supabase JWT data layer
 * replaced by same-origin cookie-auth JSON APIs (admin access is enforced
 * server-side by the /dashboard page guard and the /api/admin/* routes).
 */

import { t, uiLocale } from '@/lib/i18n';

export { escapeHtml } from '../chat/utils/html';

/**
 * Fetches JSON from a same-origin API endpoint (cookie auth).
 * Throws an Error with the server-provided message on non-2xx responses.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) {
    const message = (data as { error?: string }).error;
    throw new Error(
      message ??
        t(uiLocale(), 'dashboard.common.requestFailed', { status: res.status }),
    );
  }
  return data;
}

/** Formats a number with locale separators. */
export const formatNumber = (n: number): string => n.toLocaleString();

/** Abbreviates token counts (1.2k / 3.4M). */
export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

/** Formats an ISO date string for table display. */
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString();

/** Formats an ISO date string with time for table display. */
export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString();

/** Shows a transient success/error message in a `.dash-status` element. */
export function showStatus(
  el: HTMLElement,
  msg: string,
  type: 'success' | 'error',
): void {
  el.textContent = msg;
  el.className = `dash-status ${type === 'success' ? 'dash-status--success' : 'dash-status--error'}`;
  el.classList.remove('hidden');
  window.setTimeout(() => el.classList.add('hidden'), 4000);
}

/** Whether the dashboard currently renders in dark mode (set by the page's theme script). */
export const isDarkTheme = (): boolean =>
  document.documentElement.getAttribute('data-theme') !== 'light';

// ── Shared API types ─────────────────────────────────────────────────────────

/** User row from GET /api/admin/users */
export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  language: string | null;
  createdAt: string;
};

/** Fetches users (optionally filtered by search query). */
export async function fetchUsers(q?: string): Promise<AdminUser[]> {
  const url = q
    ? `/api/admin/users?q=${encodeURIComponent(q)}`
    : '/api/admin/users';
  const data = await fetchJson<{ users: AdminUser[] }>(url);
  return data.users ?? [];
}
