/**
 * Preview Pane — live iframe of the active chat's WORK branch
 * (`c-….<BASE_DOMAIN>`, its own worktree), falling back to the target branch
 * when no chat is active (or for the deployments system chat).
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import { annotationCount } from '@/injected/annotate';
import type { AppState, ChatSummary } from '../chat/app/state';
import { branchPreviewUrl } from './config';
import { renderNavigation } from './navigation';
import { previewDevices } from './devices';

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

/** True when the branch preview can be edited: drafts included. */
export const canEnterEditMode = (state: AppState): boolean => {
  if (!state.activeChatId) return !!state.activeBranchId;
  const chat = activeChatSummary(state);
  return !!chat && (chat.kind ?? 'workflow') === 'workflow' && state.workflowPhase !== 'published';
};

/** Toolbar while edit mode is active: tools, undo/clear, handoff, exit. */
const renderEditToolbar = (state: AppState): string => {
  const locale = uiLocale();
  const ee = state.workspace.elementEdit;
  const tools = (['cursor', 'move', 'swap', 'draw', 'comment'] as const)
    .map(
      (tool) => `<button type="button" class="ws-mini-button ${ee.tool === tool ? 'is-active' : ''}"
        data-action="ws-edit-tool" data-tool="${tool}">${escapeHtml(t(locale, `workspace.preview.tool.${tool}`))}</button>`,
    )
    .join('');
  const canHandoff = !!ee.annotations && annotationCount(ee.annotations) > 0 && !ee.busy;
  return `<div class="ws-toolbar">
      <span class="ws-toolbar__branch">${escapeHtml(t(locale, 'workspace.preview.editMode'))}</span>
      <span class="ws-toolbar__spacer"></span>
      ${tools}
      <button type="button" class="ws-mini-button" data-action="ws-edit-undo">${escapeHtml(t(locale, 'workspace.preview.editUndo'))}</button>
      <button type="button" class="ws-mini-button" data-action="ws-edit-clear">${escapeHtml(t(locale, 'workspace.preview.editClear'))}</button>
      <button type="button" class="ws-mini-button ws-mini-button--handoff" data-action="ws-edit-handoff"
        title="${escapeHtml(t(locale, 'workspace.preview.handoffTitle'))}" ${canHandoff ? '' : 'disabled aria-disabled="true"'}>
        ${escapeHtml(t(locale, 'workspace.preview.handoff'))}${ee.busy ? '…' : ''}
      </button>
      <button type="button" class="ws-mini-button" data-action="ws-edit-exit"
        title="${escapeHtml(t(locale, 'workspace.preview.exitEdit'))}" aria-label="${escapeHtml(t(locale, 'workspace.preview.exitEdit'))}">✕</button>
    </div>`;
};

/** Device preset selector — device names are brand names, not translated. */
const renderDeviceSelect = (selected: string | null): string => {
  const locale = uiLocale();
  const title = escapeHtml(t(locale, 'workspace.preview.deviceTitle'));
  const options = previewDevices()
    .map(
      (d) => `<option value="${escapeHtml(d.key)}" ${d.key === selected ? 'selected' : ''}>
        ${escapeHtml(d.key)} · ${d.width}×${d.height}</option>`,
    )
    .join('');
  return `<select class="dash-input ws-bc-select ws-device-select" data-action="ws-preview-device"
      title="${title}" aria-label="${title}">
      <option value="">${escapeHtml(t(locale, 'workspace.preview.deviceResponsive'))}</option>
      ${options}
    </select>`;
};

export const renderPreviewToolbar = (state: AppState): string => {
  const locale = uiLocale();
  const target = activeBranchName(state);
  const branch = previewBranchName(state);
  const ws = state.workspace;
  if (ws.elementEdit.active) return `${renderTabStrip(ws)}${renderEditToolbar(state)}`;
  const label =
    branch === target ? `⎇ ${escapeHtml(target)}` : `⎇ ${escapeHtml(branch)} → ${escapeHtml(target)}`;

  // Edit mode, element picker, browser compare and the code browser moved to
  // the icon rail (rail.ts) — the chrome bar keeps navigation-only controls.
  return `${renderTabStrip(ws)}
      <div class="ws-toolbar">
        <span class="ws-chrome-dots" aria-hidden="true"><i></i><i></i></span>
        <span class="ws-toolbar__branch" title="${escapeHtml(t(locale, 'workspace.preview.branchTitle'))}">${label}</span>
        ${renderNavigation('preview', ws.previewRoute)}
        <span class="ws-toolbar__spacer"></span>
        ${
          ws.pickerActive
            ? `<span class="ws-toolbar__picking">${escapeHtml(t(locale, 'workspace.preview.picking'))}</span>`
            : ''
        }
        ${renderDeviceSelect(ws.previewDevice)}
        <a class="ws-mini-button" href="${escapeHtml(branchPreviewUrl(branch, ws.previewRoute))}"
          target="_blank" rel="noopener" title="${escapeHtml(t(locale, 'workspace.preview.openNewTab'))}">↗</a>
      </div>`;
};
