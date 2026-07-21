/**
 * Diff Viewer — main-area view in the PREVIEW workflow phase.
 * Page tabs + three view modes per route:
 *   side-by-side (before/after iframes), highlight (after + diff overlay
 *   PNGs), onion (before/after screenshots with a draggable slider).
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import type { DiffViewMode } from './state';
import { branchPreviewUrl } from './config';
import { activeBranchName, previewBranchName } from './preview';

/** Catalog keys only — labels resolve at render time. */
const MODES: Array<{ key: DiffViewMode; labelKey: string }> = [
  { key: 'side-by-side', labelKey: 'workspace.diff.mode.sideBySide' },
  { key: 'scroll', labelKey: 'workspace.diff.mode.scroll' },
  { key: 'highlight', labelKey: 'workspace.diff.mode.highlight' },
  { key: 'onion', labelKey: 'workspace.diff.mode.onion' },
];

const shotUrl = (chatId: string, route: string, kind: 'before' | 'after' | 'diff' | 'before-aligned' | 'after-aligned'): string =>
  `/api/diff/${encodeURIComponent(chatId)}/shot?route=${encodeURIComponent(route)}&kind=${kind}`;

/** Screenshot <img> wrapped with a per-image loading spinner. */
const renderShot = (src: string, alt: string, extraClass = '', extraStyle = '', attrs = ''): string =>
  `<div class="ws-shot ${extraClass}" ${extraStyle ? `style="${extraStyle}"` : ''} ${attrs}>
    <span class="ws-shot__spinner"><span class="ws-spinner"></span> ${escapeHtml(t(uiLocale(), 'workspace.diff.renderingShot'))}</span>
    <img data-shot src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false" />
  </div>`;

const renderSideBySide = (state: AppState, route: string): string => {
  const locale = uiLocale();
  // before = the TARGET branch the chat merges into; after = the chat's
  // own work branch (what the execution changed)
  const before = branchPreviewUrl(activeBranchName(state), route);
  const after = branchPreviewUrl(previewBranchName(state), route);
  // Stable ids: the scroll-sync controller (diffScroll.ts) pairs these two.
  return `<div class="ws-diff-columns">
      <div class="ws-diff-col">
        <span class="ws-diff-col__label">${escapeHtml(t(locale, 'workspace.diff.beforeBranch', { branch: activeBranchName(state) }))}</span>
        <iframe id="ws-diff-before" src="${escapeHtml(before)}" title="${escapeHtml(t(locale, 'workspace.diff.beforeRoute', { route }))}"></iframe>
      </div>
      <div class="ws-diff-col">
        <span class="ws-diff-col__label">${escapeHtml(t(locale, 'workspace.diff.afterBranch', { branch: previewBranchName(state) }))}</span>
        <iframe id="ws-diff-after" src="${escapeHtml(after)}" title="${escapeHtml(t(locale, 'workspace.diff.afterRoute', { route }))}"></iframe>
      </div>
    </div>`;
};

const renderHighlight = (state: AppState, route: string): string => {
  const locale = uiLocale();
  const chatId = state.activeChatId!;
  const overlayVisible = state.workspace.diff.overlayVisible;
  const before = shotUrl(chatId, route, 'before');
  const after = shotUrl(chatId, route, 'after');
  // Box-diff rectangles over the after shot (added/changed/removed), not a
  // pixel-diff PNG — driven by markers, so rendering noise never lights up.
  const hlAttrs = overlayVisible
    ? `data-boxhl data-before="${escapeHtml(before)}" data-after="${escapeHtml(after)}"`
    : '';
  return `<div class="ws-diff-highlight">
      <div class="ws-diff-highlight__bar">
        <button type="button" class="ws-mini-button ${overlayVisible ? 'is-active' : ''}"
          data-action="ws-diff-overlay-toggle">
          ${escapeHtml(t(locale, overlayVisible ? 'workspace.diff.hideOverlay' : 'workspace.diff.showOverlay'))}
        </button>
      </div>
      <div class="ws-diff-highlight__stack">
        ${renderShot(after, t(locale, 'workspace.diff.afterRoute', { route }), '', '', hlAttrs)}
      </div>
    </div>`;
};

/** Shot-based side-by-side in ONE scroll container: both columns scroll in
 *  lockstep, and the content-align enhancer (compare mode 'content') pads
 *  matched sections so identical content sits at the same y. Shares the
 *  browser-compare scroll markup + CSS. */
const renderScroll = (state: AppState, route: string): string => {
  const locale = uiLocale();
  const chatId = state.activeChatId!;
  // Content mode: overlay the server-aligned shots (real reflow, spacer divs),
  // no client canvas. Height mode: raw shots.
  const content = state.workspace.compareMode === 'content';
  const bk = content ? 'before-aligned' : 'before';
  const ak = content ? 'after-aligned' : 'after';
  return `<div class="ws-bc-scroll">
      ${renderShot(shotUrl(chatId, route, bk), t(locale, 'workspace.diff.beforeRoute', { route }), 'ws-onion__before')}
      ${renderShot(shotUrl(chatId, route, ak), t(locale, 'workspace.diff.afterRoute', { route }), 'ws-onion__after')}
      <span class="ws-onion__label ws-onion__label--left">${escapeHtml(t(locale, 'workspace.diff.before'))}</span>
      <span class="ws-onion__label ws-onion__label--right">${escapeHtml(t(locale, 'workspace.diff.after'))}</span>
    </div>`;
};

const renderOnion = (state: AppState, route: string): string => {
  const locale = uiLocale();
  const chatId = state.activeChatId!;
  const pct = state.workspace.diff.onionPercent;
  return `<div class="ws-onion" data-onion>
      <div class="ws-onion__canvas">
        ${renderShot(shotUrl(chatId, route, 'before'), t(locale, 'workspace.diff.beforeRoute', { route }), 'ws-onion__before')}
        ${renderShot(
          shotUrl(chatId, route, 'after'),
          t(locale, 'workspace.diff.afterRoute', { route }),
          'ws-onion__after',
          // top layer visible RIGHT of the slider — matches the after label
          `clip-path: inset(0 0 0 ${pct}%);`,
        )}
        <div class="ws-onion__slider" data-action="ws-onion-handle" style="left: ${pct}%;">
          <span class="ws-onion__grip">⇔</span>
        </div>
        <span class="ws-onion__label ws-onion__label--left">${escapeHtml(t(locale, 'workspace.diff.before'))}</span>
        <span class="ws-onion__label ws-onion__label--right">${escapeHtml(t(locale, 'workspace.diff.after'))}</span>
      </div>
    </div>`;
};

export const renderDiffViewer = (state: AppState): string => {
  const locale = uiLocale();
  const diff = state.workspace.diff;

  if (diff.loading || (!diff.loaded && !diff.error)) {
    return `<div class="ws-diff ws-diff--centered">
        <span class="ws-spinner"></span>
        <span>${escapeHtml(t(locale, 'workspace.diff.loadingPages'))}</span>
      </div>`;
  }

  if (diff.error) {
    return `<div class="ws-diff ws-diff--centered">
        <p class="ws-card__note ws-card__note--danger">${escapeHtml(diff.error)}</p>
        <button type="button" class="ws-mini-button" data-action="ws-diff-reload">${escapeHtml(t(locale, 'workspace.diff.retry'))}</button>
      </div>`;
  }

  const publishing = state.workspace.publish?.status === 'running';
  const hasSha = Boolean(state.workspace.executionSha);
  const header = `<div class="ws-toolbar">
      <span class="ws-toolbar__branch">${escapeHtml(t(locale, 'workspace.diff.reviewChanges'))}</span>
      <span class="ws-toolbar__spacer"></span>
      <button type="button" class="ws-mini-button" data-action="ws-bc-open"
        title="${escapeHtml(t(locale, 'workspace.preview.browsersTitle'))}">${escapeHtml(t(locale, 'workspace.preview.browsers'))}</button>
      <button type="button" class="ws-mini-button ws-mono" data-action="ws-cb-modal-open"
        title="${escapeHtml(t(locale, 'workspace.code.openTitle'))}">{ }</button>
      <button type="button" class="ws-mini-button ws-mini-button--primary" data-action="ws-publish"
        ${!hasSha || publishing ? 'disabled' : ''}>${escapeHtml(t(locale, publishing ? 'workspace.phase.publishing' : 'workspace.phase.publish'))}</button>
      <button type="button" class="ws-mini-button" data-action="ws-request-changes">${escapeHtml(t(locale, 'workspace.phase.requestChanges'))}</button>
    </div>`;

  if (diff.pages.length === 0) {
    return `<div class="ws-diff">
        ${header}
        <div class="ws-diff--centered">
          <p class="ws-empty-note">${escapeHtml(t(locale, 'workspace.diff.noChangedPages'))}</p>
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
      data-action="ws-diff-mode" data-mode="${m.key}">${escapeHtml(t(locale, m.labelKey))}</button>`,
  ).join('');
  const contentMode = state.workspace.compareMode === 'content';
  const alignToggle = `<button type="button"
      class="ws-mini-button ${contentMode ? 'is-active' : ''}"
      data-action="ws-compare-align" title="${escapeHtml(t(locale, 'workspace.compare.title'))}">
      ${escapeHtml(t(locale, contentMode ? 'workspace.compare.content' : 'workspace.compare.height'))}</button>`;

  const route = diff.selectedRoute ?? diff.pages[0]!.route;
  let body = '';
  if (diff.mode === 'side-by-side') body = renderSideBySide(state, route);
  else if (diff.mode === 'scroll') body = renderScroll(state, route);
  else if (diff.mode === 'highlight') body = renderHighlight(state, route);
  else body = renderOnion(state, route);

  return `<div class="ws-diff">
      ${header}
      <div class="ws-diff-tabs">${tabs}</div>
      <div class="ws-diff-modes">${modes}<span class="ws-toolbar__spacer"></span>${alignToggle}</div>
      ${diff.unresolved.length ? unresolvedNote(diff.unresolved) : ''}
      <div class="ws-diff-body">${body}</div>
    </div>`;
};

const unresolvedNote = (files: string[]): string =>
  `<p class="ws-unresolved-note">
    ${escapeHtml(t(uiLocale(), 'workspace.diff.unresolvedNote'))}
    ${files.map((f) => `<span class="ws-mono">${escapeHtml(f)}</span>`).join(', ')}
  </p>`;
