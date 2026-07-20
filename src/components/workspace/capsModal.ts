/**
 * Capabilities modal — full-screen overlay showing the agent's per-chat
 * skills (installed plugins + branch-local, with shadowing), plugin rules,
 * and live MCP attachment status (codebase-memory graph incl. index status,
 * Context7 docs). Same shell/look as the git modal.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import type { CapabilityMcpRow, CapabilitySkillRow } from './state';

// ── Actions ──────────────────────────────────────────────────────────────

export const openCapsModal = (): void => {
  const c = store.state.workspace.caps;
  c.open = true;
  void loadCapabilities(store.state.activeChatId);
};

export const closeCapsModal = (): void => {
  store.state.workspace.caps.open = false;
  store.notify();
};

/** Load token — a newer load supersedes in-flight responses. */
let capsLoadSeq = 0;

export const loadCapabilities = async (chatId: string | null): Promise<void> => {
  const seq = ++capsLoadSeq;
  const c = store.state.workspace.caps;
  c.chatId = chatId;
  c.skills = [];
  c.rules = [];
  c.mcps = [];
  c.error = null;
  if (!chatId) {
    store.notify();
    return;
  }
  c.loading = true;
  store.notify();
  try {
    const res = await fetch(`/api/agent/capabilities?chat=${encodeURIComponent(chatId)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (seq !== capsLoadSeq) return;
    if (res.ok) {
      c.skills = (data.skills as CapabilitySkillRow[]) ?? [];
      c.rules = (data.rules as Array<{ plugin: string }>) ?? [];
      c.mcps = (data.mcps as CapabilityMcpRow[]) ?? [];
    } else {
      c.error =
        (data.error as string) ?? t(uiLocale(), 'workspace.git.loadFailed', { status: res.status });
    }
  } catch {
    if (seq !== capsLoadSeq) return;
    c.error = t(uiLocale(), 'workspace.git.networkError');
  }
  c.loading = false;
  store.notify();
};

// ── Rendering ────────────────────────────────────────────────────────────

const renderSkillRow = (s: CapabilitySkillRow, locale: string): string => {
  const origin =
    s.source === 'branch'
      ? t(locale, 'workspace.caps.fromBranch')
      : s.source === 'admin'
        ? t(locale, 'workspace.caps.fromAdmin')
        : t(locale, 'workspace.caps.fromPlugin', { plugin: s.plugin });
  const badge = s.shadowed
    ? `<span class="ws-caps__badge is-off">${escapeHtml(t(locale, 'workspace.caps.shadowed'))}</span>`
    : '';
  return `<div class="ws-git__row ws-caps__row ${s.shadowed ? 'is-target' : ''}">
      <span class="ws-git__info">
        <span class="ws-git__message">${escapeHtml(s.name)} ${badge}</span>
        <span class="ws-git__meta">${escapeHtml(s.description)}</span>
      </span>
      <span class="ws-git__sha">${escapeHtml(origin)}</span>
    </div>`;
};

const mcpStatus = (m: CapabilityMcpRow, locale: string): string => {
  if (m.attached)
    return `<span class="ws-caps__badge is-on">${escapeHtml(t(locale, 'workspace.caps.attached'))}</span>`;
  const reason = t(locale, `workspace.caps.reason.${m.reason ?? 'unavailable'}`);
  return `<span class="ws-caps__badge is-off">${escapeHtml(reason)}</span>`;
};

/** index_status returns JSON — pretty-print when parseable. */
const formatIndexStatus = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const renderMcpRow = (m: CapabilityMcpRow, locale: string): string => {
  const tools = m.tools.length
    ? `<span class="ws-git__meta">${escapeHtml(t(locale, 'workspace.caps.tools'))}: ${m.tools.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</span>`
    : '';
  const index = m.indexStatus
    ? `<pre class="ws-caps__index ws-mono">${escapeHtml(formatIndexStatus(m.indexStatus))}</pre>`
    : '';
  const sourceBadge =
    m.source === 'worktree'
      ? `<span class="ws-caps__badge">${escapeHtml(t(locale, 'workspace.caps.fromBranch'))}</span> `
      : '';
  return `<div class="ws-git__row ws-caps__row ${m.attached ? '' : 'is-target'}">
      <span class="ws-git__info">
        <span class="ws-git__message">${escapeHtml(m.name)} ${sourceBadge}${mcpStatus(m, locale)}</span>
        ${tools}${index}
      </span>
    </div>`;
};

const renderBody = (state: AppState): string => {
  const locale = uiLocale();
  const c = state.workspace.caps;
  if (c.loading)
    return `<div class="ws-git__empty">${escapeHtml(t(locale, 'workspace.caps.loading'))}</div>`;
  if (!c.chatId)
    return `<div class="ws-git__empty">${escapeHtml(t(locale, 'workspace.caps.noChat'))}</div>`;

  const mcpSection = `<div class="ws-git__divider">${escapeHtml(t(locale, 'workspace.caps.mcps'))}</div>
    ${c.mcps.map((m) => renderMcpRow(m, locale)).join('')}`;
  const skillSection = `<div class="ws-git__divider">${escapeHtml(t(locale, 'workspace.caps.skills'))}</div>
    ${
      c.skills.length
        ? c.skills.map((s) => renderSkillRow(s, locale)).join('')
        : `<div class="ws-git__empty">${escapeHtml(t(locale, 'workspace.caps.noSkills'))}</div>`
    }`;
  const ruleSection = c.rules.length
    ? `<div class="ws-git__divider">${escapeHtml(t(locale, 'workspace.caps.rules'))}</div>
       <div class="ws-git__row ws-caps__row"><span class="ws-git__info"><span class="ws-git__meta">
         ${c.rules.map((r) => `<code>${escapeHtml(r.plugin)}</code>`).join(' ')}
       </span></span></div>`
    : '';
  return mcpSection + skillSection + ruleSection;
};

// ── Modal shell ──────────────────────────────────────────────────────────

/** All chats offered by the selector, labeled by their own work branch
 *  (deployment chats have none — fall back to the target branch). */
const chatOptions = (state: AppState, selected: string | null): string =>
  state.branches
    .map((branch) =>
      branch.chats
        .map(
          (c) =>
            `<option value="${escapeHtml(c.id)}" ${c.id === selected ? 'selected' : ''}>
              ⎇ ${escapeHtml(c.workBranch || branch.name)} · ${escapeHtml(c.title)}</option>`,
        )
        .join(''),
    )
    .join('');

export const renderCapsModal = (state: AppState): string => {
  const locale = uiLocale();
  const c = state.workspace.caps;
  if (!c.open) return '';

  return `<div class="ws-archive ws-git" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(locale, 'workspace.caps.heading'))}">
      <div class="ws-archive__panel">
        <div class="ws-archive__head ws-git__head">
          <div class="ws-git__head-left">
            <h2 class="ws-archive__heading">${escapeHtml(t(locale, 'workspace.caps.heading'))}</h2>
            <select class="dash-input ws-git__branch" data-action="ws-caps-chat">
              ${chatOptions(state, c.chatId)}
            </select>
          </div>
          <button type="button" class="ws-mini-button" data-action="ws-caps-close"
            aria-label="${escapeHtml(t(locale, 'workspace.git.close'))}">${escapeHtml(t(locale, 'workspace.git.close'))}</button>
        </div>
        ${c.error ? `<div class="ws-archive__error">${escapeHtml(c.error)}</div>` : ''}
        <div class="ws-archive__list ws-git__body">
          ${renderBody(state)}
        </div>
      </div>
    </div>`;
};
