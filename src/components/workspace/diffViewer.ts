/**
 * Diff Viewer — main-area view in the PREVIEW workflow phase.
 * Page tabs + three view modes per route:
 *   side-by-side (before/after iframes), highlight (after + diff overlay
 *   PNGs), onion (before/after screenshots with a draggable slider).
 */

import { escapeHtml } from '../chat/utils/html';
import type { AppState } from '../chat/app/state';
import type { DiffViewMode } from './state';
import { branchPreviewUrl } from './config';
import { activeBranchName, previewBranchName } from './preview';

const MODES: Array<{ key: DiffViewMode; label: string }> = [
  { key: 'side-by-side', label: 'Side by side' },
  { key: 'highlight', label: 'Highlight' },
  { key: 'onion', label: 'Onion' },
];

const shotUrl = (chatId: string, route: string, kind: 'before' | 'after' | 'diff'): string =>
  `/api/diff/${encodeURIComponent(chatId)}/shot?route=${encodeURIComponent(route)}&kind=${kind}`;

/** Screenshot <img> wrapped with a per-image loading spinner. */
const renderShot = (src: string, alt: string, extraClass = '', extraStyle = ''): string =>
  `<div class="ws-shot ${extraClass}" ${extraStyle ? `style="${extraStyle}"` : ''}>
    <span class="ws-shot__spinner"><span class="ws-spinner"></span> Rendering screenshot…</span>
    <img data-shot src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false" />
  </div>`;

const renderSideBySide = (state: AppState, route: string): string => {
  // before = the TARGET branch the chat merges into; after = the chat's
  // own work branch (what the execution changed)
  const before = branchPreviewUrl(activeBranchName(state), route);
  const after = branchPreviewUrl(previewBranchName(state), route);
  return `<div class="ws-diff-columns">
      <div class="ws-diff-col">
        <span class="ws-diff-col__label">Before (${escapeHtml(activeBranchName(state))})</span>
        <iframe src="${escapeHtml(before)}" title="Before: ${escapeHtml(route)}"></iframe>
      </div>
      <div class="ws-diff-col">
        <span class="ws-diff-col__label">After (${escapeHtml(previewBranchName(state))})</span>
        <iframe src="${escapeHtml(after)}" title="After: ${escapeHtml(route)}"></iframe>
      </div>
    </div>`;
};

const renderHighlight = (state: AppState, route: string): string => {
  const chatId = state.activeChatId!;
  const overlayVisible = state.workspace.diff.overlayVisible;
  return `<div class="ws-diff-highlight">
      <div class="ws-diff-highlight__bar">
        <button type="button" class="ws-mini-button ${overlayVisible ? 'is-active' : ''}"
          data-action="ws-diff-overlay-toggle">
          ${overlayVisible ? 'Hide diff overlay' : 'Show diff overlay'}
        </button>
      </div>
      <div class="ws-diff-highlight__stack">
        ${renderShot(shotUrl(chatId, route, 'after'), `After: ${route}`)}
        ${overlayVisible ? renderShot(shotUrl(chatId, route, 'diff'), `Diff: ${route}`, 'ws-shot--overlay') : ''}
      </div>
    </div>`;
};

const renderOnion = (state: AppState, route: string): string => {
  const chatId = state.activeChatId!;
  const pct = state.workspace.diff.onionPercent;
  return `<div class="ws-onion" data-onion>
      ${renderShot(shotUrl(chatId, route, 'before'), `Before: ${route}`, 'ws-onion__before')}
      ${renderShot(
        shotUrl(chatId, route, 'after'),
        `After: ${route}`,
        'ws-onion__after',
        `clip-path: inset(0 ${100 - pct}% 0 0);`,
      )}
      <div class="ws-onion__slider" data-action="ws-onion-handle" style="left: ${pct}%;">
        <span class="ws-onion__grip">⇔</span>
      </div>
      <span class="ws-onion__label ws-onion__label--left">before</span>
      <span class="ws-onion__label ws-onion__label--right">after</span>
    </div>`;
};

export const renderDiffViewer = (state: AppState): string => {
  const diff = state.workspace.diff;

  if (diff.loading || (!diff.loaded && !diff.error)) {
    return `<div class="ws-diff ws-diff--centered">
        <span class="ws-spinner"></span>
        <span>Loading changed pages…</span>
      </div>`;
  }

  if (diff.error) {
    return `<div class="ws-diff ws-diff--centered">
        <p class="ws-card__note ws-card__note--danger">${escapeHtml(diff.error)}</p>
        <button type="button" class="ws-mini-button" data-action="ws-diff-reload">Retry</button>
      </div>`;
  }

  const publishing = state.workspace.publish?.status === 'running';
  const hasSha = Boolean(state.workspace.executionSha);
  const header = `<div class="ws-toolbar">
      <span class="ws-toolbar__branch">Review changes</span>
      <span class="ws-toolbar__spacer"></span>
      <button type="button" class="ws-mini-button ws-mini-button--primary" data-action="ws-publish"
        ${!hasSha || publishing ? 'disabled' : ''}>${publishing ? 'Publishing…' : 'Publish'}</button>
      <button type="button" class="ws-mini-button" data-action="ws-request-changes">Request changes</button>
    </div>`;

  if (diff.pages.length === 0) {
    return `<div class="ws-diff">
        ${header}
        <div class="ws-diff--centered">
          <p class="ws-empty-note">No changed pages were detected on this branch.</p>
          ${diff.unresolved.length ? unresolvedNote(diff.unresolved) : ''}
        </div>
      </div>`;
  }

  const tabs = diff.pages
    .map(
      (p) => `<button type="button"
        class="ws-diff-tab ${p.route === diff.selectedRoute ? 'is-active' : ''}"
        data-action="ws-diff-select-route" data-route="${escapeHtml(p.route)}"
        title="${escapeHtml(p.file)}">${escapeHtml(p.route)}</button>`,
    )
    .join('');

  const modes = MODES.map(
    (m) => `<button type="button"
      class="ws-mini-button ${m.key === diff.mode ? 'is-active' : ''}"
      data-action="ws-diff-mode" data-mode="${m.key}">${m.label}</button>`,
  ).join('');

  const route = diff.selectedRoute ?? diff.pages[0]!.route;
  let body = '';
  if (diff.mode === 'side-by-side') body = renderSideBySide(state, route);
  else if (diff.mode === 'highlight') body = renderHighlight(state, route);
  else body = renderOnion(state, route);

  return `<div class="ws-diff">
      ${header}
      <div class="ws-diff-tabs">${tabs}</div>
      <div class="ws-diff-modes">${modes}</div>
      ${diff.unresolved.length ? unresolvedNote(diff.unresolved) : ''}
      <div class="ws-diff-body">${body}</div>
    </div>`;
};

const unresolvedNote = (files: string[]): string =>
  `<p class="ws-unresolved-note">
    Changed files without a resolvable page route:
    ${files.map((f) => `<span class="ws-mono">${escapeHtml(f)}</span>`).join(', ')}
  </p>`;
