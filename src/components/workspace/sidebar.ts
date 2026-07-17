/**
 * Workspace Sidebar — branch switcher + chat list, and the workflow phase
 * bar (PLAN → EXECUTE → PREVIEW → PUBLISH) with contextual actions.
 * The chat itself (renderChatSection) is composed below these by main.ts.
 */

import { escapeHtml } from '../chat/utils/html';
import type { AppState, WorkflowPhase } from '../chat/app/state';

// ── Branch switcher + chat list ──────────────────────────────────────────

const PHASE_SHORT: Record<WorkflowPhase, string> = {
  plan: 'plan',
  execute: 'exec',
  preview: 'prev',
  published: 'pub',
};

/** Badge labels for non-workflow chat kinds. */
const KIND_LABEL: Record<string, string> = {
  deployment: 'deploy',
  deployments: 'deployments',
};

const renderBranchList = (state: AppState): string =>
  state.branches
    .map((branch) => {
      const isActive = branch.id === state.activeBranchId;
      const chats = branch.chats
        .map((chat) => {
          const isActiveChat = chat.id === state.activeChatId;
          const author = chat.createdBy?.name ? ` · ${escapeHtml(chat.createdBy.name)}` : '';
          const kind = chat.kind ?? 'workflow';
          const isWorkflow = kind === 'workflow';
          const kindBadge = isWorkflow
            ? ''
            : `<span class="ws-chat-item__kind">${escapeHtml(KIND_LABEL[kind] ?? kind)}</span>`;
          // System chats have no workflow phase worth showing
          const phase = isWorkflow ? PHASE_SHORT[chat.workflowPhase] ?? chat.workflowPhase : '';
          return `<button type="button"
              class="ws-chat-item ${isActiveChat ? 'is-active' : ''}"
              data-action="ws-open-chat" data-chat-id="${escapeHtml(chat.id)}">
              <span class="ws-chat-item__title">${escapeHtml(chat.title || 'Untitled chat')}${kindBadge}</span>
              <span class="ws-chat-item__meta">${phase}${author}</span>
            </button>`;
        })
        .join('');
      return `<div class="ws-branch ${isActive ? 'is-active' : ''}">
          <div class="ws-branch__row">
            <span class="ws-branch__name" title="${escapeHtml(branch.name)}">⎇ ${escapeHtml(branch.name)}</span>
            <button type="button" class="ws-mini-button" data-action="ws-new-chat"
              data-branch-id="${escapeHtml(branch.id)}" title="New chat on ${escapeHtml(branch.name)}">+ chat</button>
          </div>
          <div class="ws-branch__chats">${chats || '<span class="ws-empty-note">No chats yet</span>'}</div>
        </div>`;
    })
    .join('');

export const renderBranchSwitcher = (state: AppState): string => {
  const activeBranch = state.branches.find((b) => b.id === state.activeBranchId);
  const activeChat = activeBranch?.chats.find((c) => c.id === state.activeChatId);

  const panel = state.workspace.branchListOpen
    ? `<div class="ws-branch-panel">
        <div class="ws-branch-panel__actions">
          <button type="button" class="ws-mini-button" data-action="ws-new-branch">+ New branch</button>
          <button type="button" class="ws-mini-button" data-action="ws-archive-open" title="Done chats">🗄 Archive</button>
        </div>
        <div class="ws-branch-panel__list">${renderBranchList(state) || '<span class="ws-empty-note">No branches yet</span>'}</div>
      </div>`
    : '';

  return `<div class="ws-switcher">
      <button type="button" class="ws-switcher__toggle" data-action="ws-branch-list-toggle"
        aria-expanded="${state.workspace.branchListOpen}">
        <span class="ws-switcher__branch">⎇ ${escapeHtml(activeBranch?.name ?? '…')}</span>
        <span class="ws-switcher__chat">${escapeHtml(activeChat?.title ?? '')}</span>
        <span class="ws-switcher__caret">${state.workspace.branchListOpen ? '▴' : '▾'}</span>
      </button>
      ${panel}
    </div>`;
};

// ── Phase bar ────────────────────────────────────────────────────────────

const PHASE_STEPS: Array<{ key: WorkflowPhase; label: string }> = [
  { key: 'plan', label: 'Plan' },
  { key: 'execute', label: 'Execute' },
  { key: 'preview', label: 'Preview' },
  { key: 'published', label: 'Publish' },
];

/** Step bar for the active chat's automatism (deployment chats) — the
 *  non-workflow equivalent of the phase bar. */
const renderAutomatismBar = (state: AppState): string => {
  const a = state.workspace.automatism;
  if (!a || a.forChatId !== state.activeChatId || a.steps.length === 0) return '';
  const done = a.status === 'done';
  const steps = a.steps
    .map((name, i) => {
      const cls = done || i < a.step
        ? 'is-done'
        : i === a.step
          ? a.status === 'paused' || a.status === 'failed' ? 'is-failed' : 'is-current'
          : '';
      return `<span class="ws-phase-step ${cls}">${escapeHtml(name)}</span>`;
    })
    .join('<span class="ws-phase-sep">→</span>');
  // Resume is a human action too — offered whenever the automatism is
  // paused and the agent is not mid-turn.
  const agentBusy =
    state.chat?.aiChat?.phase === 'waiting' ||
    state.chat?.aiChat?.phase === 'streaming' ||
    state.chat?.aiChat?.phase === 'tool';
  const note = done
    ? '<span class="ws-phase-note">done</span>'
    : a.status === 'paused'
      ? agentBusy
        ? '<span class="ws-phase-note ws-phase-note--failed">paused — agent investigating</span>'
        : `<div class="ws-phase-actions">
            <span class="ws-phase-note ws-phase-note--failed">paused</span>
            <button type="button" class="ws-mini-button ws-mini-button--primary"
              data-action="ws-automatism-resume"
              title="Re-run the failed step (${escapeHtml(a.steps[a.step] ?? '')}) and continue">
              ▶ Resume
            </button>
          </div>`
      : a.status === 'failed'
        ? '<span class="ws-phase-note ws-phase-note--failed">failed</span>'
        : '';
  return `<div class="ws-phase-bar">
      <div class="ws-phase-steps">${steps}</div>
      ${note}
    </div>`;
};

export const renderPhaseBar = (state: AppState): string => {
  // Non-workflow chats have no PLAN→PUBLISH cycle — show automatism steps
  const activeChat = state.branches
    .flatMap((b) => b.chats)
    .find((c) => c.id === state.activeChatId);
  if (activeChat && (activeChat.kind ?? 'workflow') !== 'workflow') {
    return renderAutomatismBar(state);
  }

  const current = state.workflowPhase;
  const currentIdx = PHASE_STEPS.findIndex((s) => s.key === current);

  const steps = PHASE_STEPS.map((step, i) => {
    const cls =
      i === currentIdx ? 'is-current' : i < currentIdx ? 'is-done' : '';
    return `<span class="ws-phase-step ${cls}">${step.label}</span>`;
  }).join('<span class="ws-phase-sep">→</span>');

  // Contextual actions
  let actions = '';
  if (current === 'preview') {
    const publishing = state.workspace.publish?.status === 'running';
    const hasSha = Boolean(state.workspace.executionSha);
    actions = `<div class="ws-phase-actions">
        <button type="button" class="ws-mini-button ws-mini-button--primary" data-action="ws-publish"
          ${!hasSha || publishing ? 'disabled' : ''}
          title="${hasSha ? `Publish ${escapeHtml(state.workspace.executionSha!.slice(0, 8))}` : 'Waiting for the reviewed commit'}">
          ${publishing ? 'Publishing…' : 'Publish'}
        </button>
        <button type="button" class="ws-mini-button" data-action="ws-request-changes">Request changes</button>
      </div>`;
  }

  return `<div class="ws-phase-bar">
      <div class="ws-phase-steps">${steps}</div>
      ${actions}
    </div>`;
};
