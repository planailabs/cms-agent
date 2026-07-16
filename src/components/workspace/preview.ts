/**
 * Preview Pane — live iframe of the active chat's WORK branch
 * (`c-….<BASE_DOMAIN>`, its own worktree), falling back to the target branch
 * when no chat is active (or for the deployments system chat).
 */

import { escapeHtml } from '../chat/utils/html';
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
  if (chat && chat.kind !== 'deployments' && chat.workBranch) return chat.workBranch;
  return activeBranchName(state);
};

export const renderPreviewPane = (state: AppState): string => {
  const target = activeBranchName(state);
  const branch = previewBranchName(state);
  const src = branchPreviewUrl(branch, '/');
  const ws = state.workspace;
  const label =
    branch === target ? `⎇ ${escapeHtml(target)}` : `⎇ ${escapeHtml(branch)} → ${escapeHtml(target)}`;

  return `<div class="ws-preview">
      <div class="ws-toolbar">
        <span class="ws-toolbar__branch" title="Work branch → target branch">${label}</span>
        <span class="ws-toolbar__route ws-mono" title="Current preview route">${escapeHtml(ws.previewRoute)}</span>
        <span class="ws-toolbar__spacer"></span>
        <button type="button" class="ws-mini-button ${ws.pickerActive ? 'is-active' : ''}"
          data-action="ws-element-pick" title="Pick an element in the preview">
          ${ws.pickerActive ? 'Picking… (Esc to cancel)' : '⌖ Element picker'}
        </button>
        <a class="ws-mini-button" href="${escapeHtml(branchPreviewUrl(branch, ws.previewRoute))}"
          target="_blank" rel="noopener" title="Open preview in a new tab">↗</a>
      </div>
      <div class="ws-preview__frame">
        <iframe id="preview-iframe" src="${escapeHtml(src)}" title="Preview of ${escapeHtml(branch)}"></iframe>
      </div>
    </div>`;
};
