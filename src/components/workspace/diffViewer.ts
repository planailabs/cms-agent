/**
 * Diff Viewer — main-area view in the PREVIEW workflow phase.
 * Page tabs + three view modes per route:
 *   side-by-side (before/after iframes), highlight (after + diff overlay
 *   PNGs), onion (before/after screenshots with a draggable slider).
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import type { DiffPage, DiffState, DiffViewMode } from './state';
import { branchPreviewUrl } from './config';
import { activeBranchName, previewBranchName } from './preview';
import { store } from '../chat/app/store';

/** Route-shaped pathname: leading '/', query/hash dropped. The trailing
 *  slash is PRESERVED — sites may require it (Astro trailingSlash). */
export const normalizeDiffRoute = (input: string): string => {
  let r = input.trim().replace(/[?#].*$/, '');
  if (!r.startsWith('/')) r = `/${r}`;
  return r || '/';
};

/** Trailing-slash-insensitive identity: '/blog/x/' and '/blog/x' are the
 *  same page (else browsing a slash variant would spawn a duplicate tab). */
export const routeKey = (route: string): string => route.replace(/\/+$/, '') || '/';

/** Canonical form for a browsed route: the existing changed-page route when
 *  it is the same page, else the browsed pathname itself. */
export const canonicalDiffRoute = (pages: DiffPage[], input: string): string => {
  const raw = normalizeDiffRoute(input);
  return pages.find((p) => routeKey(p.route) === routeKey(raw))?.route ?? raw;
};

/** The route the diff view shows: the selected one, else the first changed
 *  page. Free browsing may select routes outside the changed-pages list. */
export const resolveDiffRoute = (diff: DiffState): string | null =>
  diff.selectedRoute ?? diff.pages[0]?.route ?? null;

/** Navigate the diff view (page tabs + both panes follow). */
export const navigateDiffTo = (input: string): void => {
  const diff = store.state.workspace.diff;
  const route = canonicalDiffRoute(diff.pages, input);
  const current = resolveDiffRoute(diff);
  if (!diff.loaded || (current !== null && routeKey(current) === routeKey(route))) return;
  diff.selectedRoute = route;
  store.notify();
};

/** cms:agent-ready from a diff pane → the user browsed inside it: sync the
 *  page tabs and the other pane to the new route. */
export const onDiffFrameNavigated = (route: string): void => {
  const state = store.state;
  if (state.workflowPhase !== 'preview' || state.workspace.elementEdit.active) return;
  navigateDiffTo(route);
};

/** Catalog keys only — labels resolve at render time. */
const MODES: Array<{ key: DiffViewMode; labelKey: string }> = [
  { key: 'side-by-side', labelKey: 'workspace.diff.mode.sideBySide' },
  { key: 'scroll', labelKey: 'workspace.diff.mode.scroll' },
  { key: 'highlight', labelKey: 'workspace.diff.mode.highlight' },
  { key: 'onion', labelKey: 'workspace.diff.mode.onion' },
];

/** Segmented-control glyphs (redesign) — labels stay as tooltips. */
const MODE_ICONS: Record<DiffViewMode, string> = {
  'side-by-side': `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.6" y="3" width="5.4" height="10" rx="1.2"/><rect x="9" y="3" width="5.4" height="10" rx="1.2"/></svg>`,
  scroll: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.4" y="2" width="11.2" height="12" rx="1.6"/><path d="M8 5.2v5.6M6 8.8L8 10.8l2-2"/></svg>`,
  highlight: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><rect x="4" y="5" width="8" height="2.4" rx="0.8" fill="currentColor" stroke="none" opacity="0.55"/><path d="M4 10.4h5.6"/></svg>`,
  onion: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6.2" cy="8" r="4.4"/><circle cx="9.8" cy="8" r="4.4"/></svg>`,
};

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
  const content = state.workspace.compareMode === 'content';
  const bk = content ? 'before-aligned' : 'before';
  const ak = content ? 'after-aligned' : 'after';
  return `<div class="ws-onion">
      <div class="ws-onion__canvas">
        ${renderShot(shotUrl(chatId, route, bk), t(locale, 'workspace.diff.beforeRoute', { route }), 'ws-onion__before')}
        ${renderShot(
          shotUrl(chatId, route, ak),
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
  // Tool entry points (edit mode, picker, browsers, code) live in the icon
  // rail (rail.ts) — the chrome bar keeps the review verdict actions.
  const header = `<div class="ws-toolbar">
      <span class="ws-chrome-dots" aria-hidden="true"><i></i><i></i></span>
      <span class="ws-toolbar__branch">${escapeHtml(t(locale, 'workspace.diff.reviewChanges'))}</span>
      <span class="ws-toolbar__spacer"></span>
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

  const route = resolveDiffRoute(diff) ?? diff.pages[0]!.route;
  const routeItem = (r: string, file: string | null, active: boolean): string => `<button type="button"
      class="ws-route-pop__item ${active ? 'is-active' : ''}" role="menuitem"
      data-action="ws-diff-select-route" data-route="${escapeHtml(r)}"
      ${file ? `title="${escapeHtml(file)}"` : ''}>
      <span class="ws-route-pop__route ws-mono">${escapeHtml(r)}</span>
      ${file ? `<span class="ws-route-pop__file">${escapeHtml(file.split('/').pop() ?? '')}</span>` : ''}
    </button>`;
  // Free browsing (links inside a pane or the address input) may leave the
  // changed-pages list — show where the user is as a transient entry.
  const onChangedPage = diff.pages.some((p) => routeKey(p.route) === routeKey(route));
  const items =
    (onChangedPage ? '' : routeItem(route, t(locale, 'workspace.diff.browsedPage'), true)) +
    diff.pages
      .map((p) => routeItem(p.route, p.file, routeKey(p.route) === routeKey(route)))
      .join('');
  const pop = diff.routesOpen
    ? `<div class="ws-route-pop" role="menu">
        <div class="ws-route-pop__head">${escapeHtml(t(locale, 'workspace.diff.routesTitle'))}</div>
        ${items}
      </div>`
    : '';
  const routeSelect = `<div class="ws-route-select" data-menu="diff-routes">
      <button type="button" class="ws-route-chip" data-action="ws-diff-routes-toggle"
        data-active-route="${escapeHtml(route)}" aria-haspopup="menu" aria-expanded="${diff.routesOpen}">
        <span class="ws-route-chip__route ws-mono">${escapeHtml(route)}</span>
        <span class="ws-switcher__caret">${diff.routesOpen ? '▴' : '▾'}</span>
      </button>
      ${pop}
    </div>
    <span class="ws-diff-count">${escapeHtml(t(locale, 'workspace.diff.changedCount', { count: String(diff.pages.length) }))}</span>`;

  const modes = MODES.map(
    (m) => `<button type="button"
      class="ws-seg__btn ${m.key === diff.mode ? 'is-active' : ''}"
      data-action="ws-diff-mode" data-mode="${m.key}"
      title="${escapeHtml(t(locale, m.labelKey))}" aria-label="${escapeHtml(t(locale, m.labelKey))}">${MODE_ICONS[m.key]}</button>`,
  ).join('');
  const contentMode = state.workspace.compareMode === 'content';
  const alignToggle = `<button type="button"
      class="ws-mini-button ${contentMode ? 'is-active' : ''}"
      data-action="ws-compare-align" title="${escapeHtml(t(locale, 'workspace.compare.title'))}">
      ${escapeHtml(t(locale, contentMode ? 'workspace.compare.content' : 'workspace.compare.height'))}</button>`;

  let body = '';
  if (diff.mode === 'side-by-side') body = renderSideBySide(state, route);
  else if (diff.mode === 'scroll') body = renderScroll(state, route);
  else if (diff.mode === 'highlight') body = renderHighlight(state, route);
  else body = renderOnion(state, route);

  const address = `<form class="ws-address" data-action="ws-diff-address-form"
      title="${escapeHtml(t(locale, 'workspace.preview.addressTitle'))}">
      <input class="ws-address__input ws-mono" type="text" spellcheck="false"
        autocomplete="off" value="${escapeHtml(route)}" aria-label="${escapeHtml(t(locale, 'workspace.preview.addressLabel'))}" />
    </form>`;

  return `<div class="ws-diff">
      ${header}
      <div class="ws-diff-controls">${routeSelect}<span class="ws-vr"></span><div class="ws-seg">${modes}</div>${address}<span class="ws-toolbar__spacer"></span>${alignToggle}</div>
      ${diff.unresolved.length ? unresolvedNote(diff.unresolved) : ''}
      <div class="ws-diff-body">${body}</div>
    </div>`;
};

const unresolvedNote = (files: string[]): string =>
  `<p class="ws-unresolved-note">
    ${escapeHtml(t(uiLocale(), 'workspace.diff.unresolvedNote'))}
    ${files.map((f) => `<span class="ws-mono">${escapeHtml(f)}</span>`).join(', ')}
  </p>`;
