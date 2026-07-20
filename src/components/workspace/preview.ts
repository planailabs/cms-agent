/**
 * Preview Pane — live iframe of the active chat's WORK branch
 * (`c-….<BASE_DOMAIN>`, its own worktree), falling back to the target branch
 * when no chat is active (or for the deployments system chat).
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState, ChatSummary } from '../chat/app/state';
import { branchPreviewUrl } from './config';

export const activeBranchName = (state: AppState): string =>
  state.branches.find((b) => b.id === state.activeBranchId)?.name ?? 'main';

const activeChatSummary = (state: AppState): ChatSummary | null => {
  for (const branch of state.branches) {
    const chat = branch.chats.find((c) => c.id === state.activeChatId);
    if (chat) return chat;
  }
  return null;
};

/** Branch label whose preview the main pane shows. */
export const previewBranchName = (state: AppState): string => {
  const chat = activeChatSummary(state);
  // Deployment/system chats have no real worktree — show the target branch
  if (chat && (chat.kind ?? 'workflow') === 'workflow' && chat.workBranch) return chat.workBranch;
  return activeBranchName(state);
};

/**
 * Skeleton with separate sub-regions for the toolbar and the iframe, so
 * toolbar-only state changes (picker armed, route chip) never replace the
 * markup containing the iframe — replacing an iframe node reloads it.
 */
export const renderPreviewSkeleton = (): string =>
  `<div class="ws-preview">
      <div id="preview-toolbar-region"></div>
      <div id="preview-frame-region" class="ws-preview__frame"></div>
    </div>`;

const renderTabStrip = (ws: AppState['workspace']): string => {
  const locale = uiLocale();
  const tabs = ws.previewTabs
    .map((route, i) => {
      const active = i === ws.activeTabIndex;
      const close =
        ws.previewTabs.length > 1
          ? `<span class="ws-tab__close" data-action="ws-tab-close" data-index="${i}"
              role="button" aria-label="${escapeHtml(t(locale, 'workspace.preview.closeTab'))}" title="${escapeHtml(t(locale, 'workspace.preview.closeTab'))}">×</span>`
          : '';
      return `<button type="button" class="ws-tab ${active ? 'is-active' : ''}"
          data-action="ws-tab-switch" data-index="${i}" title="${escapeHtml(route)}">
          <span class="ws-tab__label ws-mono">${escapeHtml(route)}</span>${close}
        </button>`;
    })
    .join('');
  return `<div class="ws-tabs" role="tablist">
      ${tabs}
      <button type="button" class="ws-tab ws-tab--new" data-action="ws-tab-new"
        title="${escapeHtml(t(locale, 'workspace.preview.newTab'))}" aria-label="${escapeHtml(t(locale, 'workspace.preview.newTab'))}">+</button>
    </div>`;
};

export const renderPreviewToolbar = (state: AppState): string => {
  const locale = uiLocale();
  const target = activeBranchName(state);
  const branch = previewBranchName(state);
  const ws = state.workspace;
  const label =
    branch === target ? `⎇ ${escapeHtml(target)}` : `⎇ ${escapeHtml(branch)} → ${escapeHtml(target)}`;

  return `${renderTabStrip(ws)}
      <div class="ws-toolbar">
        <span class="ws-toolbar__branch" title="${escapeHtml(t(locale, 'workspace.preview.branchTitle'))}">${label}</span>
        <form class="ws-address" data-action="ws-address-form" title="${escapeHtml(t(locale, 'workspace.preview.addressTitle'))}">
          <input class="ws-address__input ws-mono" type="text" spellcheck="false"
            autocomplete="off" value="${escapeHtml(ws.previewRoute)}" aria-label="${escapeHtml(t(locale, 'workspace.preview.addressLabel'))}" />
        </form>
        <span class="ws-toolbar__spacer"></span>
        <button type="button" class="ws-mini-button ${ws.pickerActive ? 'is-active' : ''}"
          data-action="ws-element-pick" title="${escapeHtml(t(locale, 'workspace.preview.pickTitle'))}">
          ${escapeHtml(t(locale, ws.pickerActive ? 'workspace.preview.picking' : 'workspace.preview.elementPicker'))}
        </button>
        <button type="button" class="ws-mini-button" data-action="ws-bc-open"
          title="${escapeHtml(t(locale, 'workspace.preview.browsersTitle'))}">${escapeHtml(t(locale, 'workspace.preview.browsers'))}</button>
        <a class="ws-mini-button" href="${escapeHtml(branchPreviewUrl(branch, ws.previewRoute))}"
          target="_blank" rel="noopener" title="${escapeHtml(t(locale, 'workspace.preview.openNewTab'))}">↗</a>
      </div>`;
};

