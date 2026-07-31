/**
 * Navigation bar — the route input plus its reload button, shared by every
 * window that browses the site: the preview chrome and the compare window's
 * control row. Both used to carry their own copy of the address form with a
 * scope-specific action name; the scope now travels as data, so one markup and
 * one pair of handlers (see events.ts) serve them all.
 */
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';

/** Which window the bar drives — decides where submit and reload go. */
export type NavScope = 'preview' | 'diff';

const RELOAD_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.4 2.8v3.1h-3.1"/></svg>`;
/**
 * Power-cycle over a server stack: the power ring says "the machine", its
 * arrowhead says "again", and the two racked bars underneath say which machine
 * — the box serving the page, not the page. The reload button next to it is a
 * plain circular arrow, so the two never read as the same action.
 */
const RESTART_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.9v3.3"/><path d="M5.45 3.85a3.6 3.6 0 1 0 5.1 0"/><path d="M9.4 2.6 10.9 3.75 9.7 5.05"/><rect x="2.3" y="11.7" width="11.4" height="2.9" rx="0.9"/><path d="M4.5 13.15h.01M6.4 13.15h.01"/></svg>`;

export const renderNavigation = (scope: NavScope, route: string): string => {
  const locale = uiLocale();
  const reload = escapeHtml(t(locale, 'workspace.preview.reload'));
  const restart = escapeHtml(t(locale, 'workspace.preview.restart'));
  return `<div class="ws-nav" data-nav="${scope}">
      <button type="button" class="ws-mini-button ws-nav__reload" data-action="ws-nav-reload"
        data-scope="${scope}" title="${reload}" aria-label="${reload}">${RELOAD_ICON}</button>
      <button type="button" class="ws-mini-button ws-nav__restart" data-action="ws-nav-restart"
        data-scope="${scope}" title="${restart}" aria-label="${restart}">${RESTART_ICON}</button>
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
