/**
 * Plan modal — full-screen overlay (same shell as the git/capabilities
 * modals) showing the chat's proposed plan. Available in EVERY phase:
 * during PLAN it mirrors the pending propose_plan card; after approval it
 * renders chat.planJson (from history), so it also works while executing
 * and in archived chats.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import { renderPlanRiskBadge, renderPlanSections } from '../chat/ui/chat/cards';
import type { ProposedPlan } from './state';

/** The plan visible to the active chat: a pending propose_plan question
 *  wins (it is the newest draft), else the approved chat.planJson. */
export const currentPlan = (state: AppState): ProposedPlan | null => {
  const mc = state.chat?.aiChat;
  if (mc?.phase === 'question' && mc.clientPrompt?.toolName === 'propose_plan') {
    return mc.clientPrompt.input as ProposedPlan;
  }
  return state.workspace.plan;
};

export const openPlanModal = (): void => {
  store.state.workspace.planModalOpen = true;
  store.notify();
};

export const closePlanModal = (): void => {
  store.state.workspace.planModalOpen = false;
  store.notify();
};

export const renderPlanModal = (state: AppState): string => {
  if (!state.workspace.planModalOpen) return '';
  const locale = uiLocale();
  const plan = currentPlan(state);

  return `<div class="ws-archive ws-git" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(locale, 'chat.plan.title'))}">
      <div class="ws-archive__panel">
        <div class="ws-archive__head ws-git__head">
          <div class="ws-git__head-left">
            <h2 class="ws-archive__heading">${escapeHtml(t(locale, 'chat.plan.title'))}</h2>
            ${plan ? renderPlanRiskBadge(plan, locale) : ''}
          </div>
          <button type="button" class="ws-mini-button" data-action="ws-plan-close"
            aria-label="${escapeHtml(t(locale, 'workspace.git.close'))}">${escapeHtml(t(locale, 'workspace.git.close'))}</button>
        </div>
        <div class="ws-archive__list ws-git__body">
          ${
            plan
              ? `<div class="ws-card ws-plan-modal__card">${renderPlanSections(plan, locale)}</div>`
              : `<span class="ws-empty-note">${escapeHtml(t(locale, 'chat.plan.none'))}</span>`
          }
        </div>
      </div>
    </div>`;
};
