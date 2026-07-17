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
          const isWorkflow = (chat.kind ?? 'workflow') === 'workflow';
          const kindBadge = isWorkflow
            ? ''
            : `<span class="ws-chat-item__kind">${escapeHtml(KIND_LABEL[chat.kind] ?? chat.kind)}</span>`;
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

export const renderPhaseBar = (state: AppState): string => {
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
