/**
 * Preview Pane — live iframe of the active branch (`<branch>.<BASE_DOMAIN>`)
 * with a small toolbar (current route, element picker, open in new tab).
 */

import { escapeHtml } from '../chat/utils/html';
import type { AppState } from '../chat/app/state';
import { branchPreviewUrl } from './config';

export const activeBranchName = (state: AppState): string =>
  state.branches.find((b) => b.id === state.activeBranchId)?.name ?? 'main';

export const renderPreviewPane = (state: AppState): string => {
  const branch = activeBranchName(state);
  const src = branchPreviewUrl(branch, '/');
  const ws = state.workspace;

  return `<div class="ws-preview">
      <div class="ws-toolbar">
        <span class="ws-toolbar__branch">⎇ ${escapeHtml(branch)}</span>
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
