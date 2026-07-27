/**
 * Workspace Sidebar — branch switcher + chat list, and the workflow phase
 * bar (PLAN → EXECUTE → PREVIEW → PUBLISH) with contextual actions.
 * The chat itself (renderChatSection) is composed below these by main.ts.
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState, WorkflowPhase } from '../chat/app/state';
import { currentPlan } from './planModal';

// ── Branch switcher + chat list ──────────────────────────────────────────

/** Catalog keys only — labels resolve at render time (uiLocale may change). */
const PHASE_SHORT_KEY: Record<WorkflowPhase, string> = {
  plan: 'workspace.sidebar.phaseShort.plan',
  execute: 'workspace.sidebar.phaseShort.execute',
  preview: 'workspace.sidebar.phaseShort.preview',
  published: 'workspace.sidebar.phaseShort.published',
};

/** Badge label keys for non-workflow chat kinds. */
const KIND_LABEL_KEY: Record<string, string> = {
  deployment: 'workspace.sidebar.kind.deployment',
  deployments: 'workspace.sidebar.kind.deployments',
};

/** Automatism step label: catalog entry when known, raw step name otherwise. */
const stepLabel = (name: string): string => {
  const key = `automatism.step.${name}`;
  const label = t(uiLocale(), key);
  return label === key ? name : label;
};

const renderBranchList = (state: AppState): string => {
  const locale = uiLocale();
  return state.branches
    .map((branch) => {
      const isActive = branch.id === state.activeBranchId;
      const chats = branch.chats
        .map((chat) => {
          const isActiveChat = chat.id === state.activeChatId;
          const author = chat.createdBy?.name ? ` · ${escapeHtml(chat.createdBy.name)}` : '';
          const kind = chat.kind ?? 'workflow';
          const isWorkflow = kind === 'workflow';
          const kindLabel = KIND_LABEL_KEY[kind] ? t(locale, KIND_LABEL_KEY[kind]) : kind;
          const kindBadge = isWorkflow
            ? ''
            : `<span class="ws-chat-item__kind">${escapeHtml(kindLabel)}</span>`;
          // System chats have no workflow phase worth showing
          const phase = isWorkflow
            ? PHASE_SHORT_KEY[chat.workflowPhase]
              ? escapeHtml(t(locale, PHASE_SHORT_KEY[chat.workflowPhase]))
              : escapeHtml(chat.workflowPhase)
            : '';
          return `<button type="button"
              class="ws-chat-item ${isActiveChat ? 'is-active' : ''}"
              data-action="ws-open-chat" data-chat-id="${escapeHtml(chat.id)}">
              <span class="ws-chat-item__title">${escapeHtml(chat.title || t(locale, 'workspace.sidebar.untitledChat'))}${kindBadge}</span>
              <span class="ws-chat-item__meta">${phase}${author}</span>
            </button>`;
        })
        .join('');
      return `<div class="ws-branch ${isActive ? 'is-active' : ''}">
          <div class="ws-branch__row">
            <span class="ws-branch__name" title="${escapeHtml(branch.name)}">⎇ ${escapeHtml(branch.name)}</span>
            <button type="button" class="ws-mini-button" data-action="ws-new-chat"
              data-branch-id="${escapeHtml(branch.id)}" title="${escapeHtml(t(locale, 'workspace.sidebar.newChatOn', { branch: branch.name }))}">${escapeHtml(t(locale, 'workspace.sidebar.newChatButton'))}</button>
          </div>
          <div class="ws-branch__chats">${chats || `<span class="ws-empty-note">${escapeHtml(t(locale, 'workspace.sidebar.noChats'))}</span>`}</div>
        </div>`;
    })
    .join('');
};

export const renderBranchSwitcher = (state: AppState): string => {
  const locale = uiLocale();
  const activeBranch = state.branches.find((b) => b.id === state.activeBranchId);
  const activeChat = activeBranch?.chats.find((c) => c.id === state.activeChatId);

  // Git/Skills/Archive/Windows moved to the icon rail (rail.ts) — the branch
  // panel keeps branch-scoped actions only.
  const panel = state.workspace.branchListOpen
    ? `<div class="ws-branch-panel">
        <div class="ws-branch-panel__actions">
          <button type="button" class="ws-mini-button" data-action="ws-new-branch">${escapeHtml(t(locale, 'workspace.sidebar.newBranch'))}</button>
        </div>
        <div class="ws-branch-panel__list">${renderBranchList(state) || `<span class="ws-empty-note">${escapeHtml(t(locale, 'workspace.sidebar.noBranches'))}</span>`}</div>
      </div>`
    : '';

  // One-click chat creation on the active branch — the panel's per-branch
  // "+ chat" buttons stay for other branches.
  const newChat = activeBranch
    ? `<button type="button" class="ws-switcher__new" data-action="ws-new-chat"
        data-branch-id="${escapeHtml(activeBranch.id)}"
        title="${escapeHtml(t(locale, 'workspace.sidebar.newChatOn', { branch: activeBranch.name }))}"
        aria-label="${escapeHtml(t(locale, 'workspace.sidebar.newChatOn', { branch: activeBranch.name }))}">＋</button>`
    : '';
  return `<div class="ws-switcher">
      <button type="button" class="ws-switcher__toggle" data-action="ws-branch-list-toggle"
        aria-expanded="${state.workspace.branchListOpen}">
        <span class="ws-switcher__dot" aria-hidden="true"></span>
        <span class="ws-switcher__branch">⎇ ${escapeHtml(activeBranch?.name ?? '…')}</span>
        <span class="ws-switcher__chat">${escapeHtml(activeChat?.title ?? state.activeChatTitle ?? '')}</span>
        <span class="ws-switcher__caret">${state.workspace.branchListOpen ? '▴' : '▾'}</span>
      </button>
      ${newChat}
      ${panel}
    </div>`;
};

// ── Phase bar ────────────────────────────────────────────────────────────

/** Catalog keys only — labels resolve at render time. */
const PHASE_STEPS: Array<{ key: WorkflowPhase; labelKey: string }> = [
  { key: 'plan', labelKey: 'workspace.phase.plan' },
  { key: 'execute', labelKey: 'workspace.phase.execute' },
  { key: 'preview', labelKey: 'workspace.phase.preview' },
  { key: 'published', labelKey: 'workspace.phase.published' },
];

/** Step bar for the active chat's automatism (deployment chats) — the
 *  non-workflow equivalent of the phase bar. */
const renderAutomatismBar = (state: AppState): string => {
  const locale = uiLocale();
  const a = state.workspace.automatism;
  if (!a || a.forChatId !== state.activeChatId || a.steps.length === 0) return '';
  // A finished automatism leaves the bar — its result lives in the transcript
  if (a.status === 'done') return '';
  const steps = a.steps
    .map((name, i) => {
      const cls = i < a.step
        ? 'is-done'
        : i === a.step
          ? a.status === 'paused' || a.status === 'failed' ? 'is-failed' : 'is-current'
          : '';
      return `<span class="ws-phase-step ${cls}">${escapeHtml(stepLabel(name))}</span>`;
    })
    .join('<span class="ws-phase-sep">→</span>');
  // Resume is a human action too — offered whenever the automatism is
  // paused and the agent is not mid-turn.
  const agentBusy =
    state.chat?.aiChat?.phase === 'waiting' ||
    state.chat?.aiChat?.phase === 'streaming' ||
    state.chat?.aiChat?.phase === 'tool';
  const failedStep = a.steps[a.step] ? stepLabel(a.steps[a.step]!) : '';
  const note =
    a.status === 'paused'
      ? agentBusy
        ? `<span class="ws-phase-note ws-phase-note--failed">${escapeHtml(t(locale, 'workspace.phase.pausedInvestigating'))}</span>`
        : `<div class="ws-phase-actions">
            <span class="ws-phase-note ws-phase-note--failed">${escapeHtml(t(locale, 'workspace.phase.paused'))}</span>
            <button type="button" class="ws-mini-button ws-mini-button--primary"
              data-action="ws-automatism-resume"
              title="${escapeHtml(t(locale, 'workspace.phase.resumeTitle', { step: failedStep }))}">
              ${escapeHtml(t(locale, 'workspace.phase.resume'))}
            </button>
          </div>`
      : a.status === 'failed'
        ? `<span class="ws-phase-note ws-phase-note--failed">${escapeHtml(t(locale, 'workspace.phase.failed'))}</span>`
        : '';
  return `<div class="ws-phase-bar">
      <div class="ws-phase-steps">${steps}</div>
      ${note}
    </div>`;
};

export const renderPhaseBar = (state: AppState): string => {
  // Non-workflow chats have no PLAN→PUBLISH cycle — show automatism steps.
  // activeChatKind survives the chat leaving the sidebar (archived).
  if (state.activeChatKind !== 'workflow') {
    return renderAutomatismBar(state);
  }

  const locale = uiLocale();
  const current = state.workflowPhase;
  const currentIdx = PHASE_STEPS.findIndex((s) => s.key === current);

  const steps = PHASE_STEPS.map((step, i) => {
    const cls =
      i === currentIdx ? 'is-current' : i < currentIdx ? 'is-done' : '';
    return `<span class="ws-phase-step ${cls}">${escapeHtml(t(locale, step.labelKey))}</span>`;
  }).join('<span class="ws-phase-sep">→</span>');

  // Contextual actions — Sync rebases the draft onto the latest target;
  // only offered while the target actually has commits the draft lacks.
  const syncing =
    state.workspace.automatism?.forChatId === state.activeChatId &&
    state.workspace.automatism.status === 'running';
  const syncButton =
    state.workspace.targetAhead || syncing
      ? `<button type="button" class="ws-mini-button" data-action="ws-sync"
          ${syncing ? 'disabled' : ''} title="${escapeHtml(t(locale, 'workspace.phase.syncTitle'))}">
          ${escapeHtml(t(locale, syncing ? 'workspace.phase.syncing' : 'workspace.phase.sync'))}
        </button>`
      : '';
  // Plan button — visible in every phase (archived chats included) as soon
  // as a plan exists; opens the fullscreen plan modal.
  const planButton = currentPlan(state)
    ? `<button type="button" class="ws-mini-button" data-action="ws-plan-open"
        title="${escapeHtml(t(locale, 'chat.plan.view'))}">${escapeHtml(t(locale, 'chat.plan.viewButton'))}</button>`
    : '';
  let actions = `<div class="ws-phase-actions">${planButton}${syncButton}</div>`;
  if (current === 'preview') {
    const publishing = state.workspace.publish?.status === 'running';
    const hasSha = Boolean(state.workspace.executionSha);
    actions = `<div class="ws-phase-actions">
        ${planButton}${syncButton}
        <button type="button" class="ws-mini-button ws-mini-button--primary" data-action="ws-publish"
          ${!hasSha || publishing ? 'disabled' : ''}
          title="${hasSha ? escapeHtml(t(locale, 'workspace.phase.publishSha', { sha: state.workspace.executionSha!.slice(0, 8) })) : escapeHtml(t(locale, 'workspace.phase.waitingForCommit'))}">
          ${escapeHtml(t(locale, publishing ? 'workspace.phase.publishing' : 'workspace.phase.publish'))}
        </button>
        <button type="button" class="ws-mini-button" data-action="ws-request-changes">${escapeHtml(t(locale, 'workspace.phase.requestChanges'))}</button>
      </div>`;
  }

  // A running/paused automatism on THIS chat (e.g. a sync) shows its own
  // step bar below the workflow phases — incl. the ▶ Resume button.
  return `<div class="ws-phase-bar">
      <div class="ws-phase-steps">${steps}</div>
      ${actions}
    </div>${renderAutomatismBar(state)}`;
};
