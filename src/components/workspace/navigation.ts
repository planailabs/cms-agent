/**
 * Navigation bar — the route input plus its reload button, shared by every
 * window that browses the site: the preview chrome and the compare window's
 * control row. Both used to carry their own copy of the address form with a
 * scope-specific action name; the scope now travels as data, so one markup and
 * one pair of handlers (see events.ts) serve them all.
 */
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import { canGoBack, canGoForward, createNavHistory, type NavHistory, type NavScope } from './navHistory';

export type { NavScope } from './navHistory';

const RELOAD_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.4 2.8v3.1h-3.1"/></svg>`;

const BACK_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.2 5.2 8l4.8 4.8"/></svg>`;
const FORWARD_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.2 10.8 8 6 12.8"/></svg>`;
/** A clock face: the list is "where this window has been", not a menu. */
const HISTORY_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.7"/><path d="M8 4.6V8l2.4 1.6"/></svg>`;

/**
 * The history list, newest first. It is rendered from the same stack Back and
 * Forward walk, so what the user sees and what those buttons do cannot drift;
 * the entry they are on is marked rather than hidden.
 */
const renderHistoryList = (scope: NavScope, history: NavHistory): string => {
  if (history.entries.length === 0) return '';
  const rows = history.entries
    .map((entry, i) => ({ entry, i }))
    .reverse()
    .map(
      ({ entry, i }) =>
        `<button type="button" class="ws-nav__history-item${i === history.index ? ' is-current' : ''}"
          data-action="ws-nav-history-jump" data-scope="${scope}" data-index="${i}">
          <span class="ws-mono">${escapeHtml(entry)}</span>
        </button>`,
    )
    .join('');
  return `<div class="ws-nav__history" data-nav-history="${scope}">${rows}</div>`;
};

export const renderNavigation = (
  scope: NavScope,
  route: string,
  history: NavHistory = createNavHistory(),
  historyOpen = false,
): string => {
  const locale = uiLocale();
  const reload = escapeHtml(t(locale, 'workspace.preview.reload'));
  const back = escapeHtml(t(locale, 'workspace.preview.back'));
  const forward = escapeHtml(t(locale, 'workspace.preview.forward'));
  const historyLabel = escapeHtml(t(locale, 'workspace.preview.history'));
  // Disabled rather than hidden: the buttons keep their place in the row, so
  // the address bar does not shift as the history grows.
  const off = (on: boolean) => (on ? '' : ' disabled aria-disabled="true"');
  return `<div class="ws-nav" data-nav="${scope}">
      <button type="button" class="ws-mini-button ws-nav__back" data-action="ws-nav-back"
        data-scope="${scope}" title="${back}" aria-label="${back}"${off(canGoBack(history))}>${BACK_ICON}</button>
      <button type="button" class="ws-mini-button ws-nav__forward" data-action="ws-nav-forward"
        data-scope="${scope}" title="${forward}" aria-label="${forward}"${off(canGoForward(history))}>${FORWARD_ICON}</button>
      <div class="ws-nav__history-wrap">
        <button type="button" class="ws-mini-button ws-nav__history-toggle${historyOpen ? ' is-active' : ''}"
          data-action="ws-nav-history" data-scope="${scope}" title="${historyLabel}"
          aria-label="${historyLabel}" aria-expanded="${historyOpen ? 'true' : 'false'}"${off(history.entries.length > 0)}>${HISTORY_ICON}</button>
        ${historyOpen ? renderHistoryList(scope, history) : ''}
      </div>
      <button type="button" class="ws-mini-button ws-nav__reload" data-action="ws-nav-reload"
        data-scope="${scope}" title="${reload}" aria-label="${reload}">${RELOAD_ICON}</button>
      <form class="ws-address" data-action="ws-nav-go" data-scope="${scope}"
        title="${escapeHtml(t(locale, 'workspace.preview.addressTitle'))}">
        <input class="ws-address__input ws-mono" type="text" spellcheck="false" autocomplete="off"
          value="${escapeHtml(route)}" aria-label="${escapeHtml(t(locale, 'workspace.preview.addressLabel'))}" />
      </form>
    </div>`;
};

/**
 * The same shot with a fresh nonce. Reassigning an identical URL would be
 * answered from the memory cache, so the reload would show the old capture;
 * the parameter itself means nothing to the endpoint.
 */
export const shotReloadUrl = (src: string, nonce: number): string => {
  const [path, query = ''] = src.split('?');
  const params = new URLSearchParams(query);
  params.set('_r', String(nonce));
  return `${path}?${params.toString()}`;
};

let shotNonce = 0;

/**
 * Screenshot modes have no document to reload — re-request the images and put
 * their spinners back, so a reload looks like one in every view mode.
 */
export const refetchShots = (root: ParentNode): void => {
  const nonce = ++shotNonce;
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-shot]')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    img.closest('.ws-shot')?.classList.remove('is-loaded', 'is-failed');
    img.setAttribute('src', shotReloadUrl(src, nonce));
  }
};
