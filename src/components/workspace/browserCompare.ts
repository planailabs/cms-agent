/**
 * Cross-browser comparison overlay — renders the current route in two browser
 * engines (via /api/preview/browsers-shot) and compares them with the same
 * highlight/onion widgets the diff viewer uses. Shown in the main area in
 * both the PREVIEW phase and regular preview mode.
 */

import { escapeHtml } from '../chat/utils/html';
import type { AppState } from '../chat/app/state';
import type { BrowserName } from './state';
import { previewBranchName } from './preview';

const BROWSERS: Array<{ key: BrowserName; label: string }> = [
  { key: 'chromium', label: 'Chromium' },
  { key: 'firefox', label: 'Firefox' },
  { key: 'webkit', label: 'WebKit' },
];

const shotUrl = (
  branch: string,
  route: string,
  a: BrowserName,
  b: BrowserName,
  kind: 'before' | 'after' | 'diff',
): string =>
  `/api/preview/browsers-shot?branch=${encodeURIComponent(branch)}` +
  `&route=${encodeURIComponent(route)}&a=${a}&b=${b}&kind=${kind}`;

const renderShot = (src: string, alt: string, extraClass = '', extraStyle = ''): string =>
  `<div class="ws-shot ${extraClass}" ${extraStyle ? `style="${extraStyle}"` : ''}>
    <span class="ws-shot__spinner"><span class="ws-spinner"></span> Rendering ${escapeHtml(alt)}…</span>
    <img data-shot src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false" />
  </div>`;

const browserSelect = (which: 'a' | 'b', selected: BrowserName): string =>
  `<select class="dash-input ws-bc-select" data-action="ws-bc-browser" data-which="${which}">
    ${BROWSERS.map(
      (o) => `<option value="${o.key}" ${o.key === selected ? 'selected' : ''}>${o.label}</option>`,
    ).join('')}
  </select>`;

export const renderBrowserCompare = (state: AppState): string => {
  const bc = state.workspace.browserCompare;
  const branch = previewBranchName(state);
  const route = state.workspace.previewRoute;

  const body =
    bc.mode === 'onion'
      ? `<div class="ws-onion" data-onion data-onion-target="browserCompare">
          ${renderShot(shotUrl(branch, route, bc.a, bc.b, 'before'), bc.a, 'ws-onion__before')}
          ${renderShot(
            shotUrl(branch, route, bc.a, bc.b, 'after'),
            bc.b,
            'ws-onion__after',
            `clip-path: inset(0 ${100 - bc.onionPercent}% 0 0);`,
          )}
          <div class="ws-onion__slider" data-action="ws-bc-onion-handle" style="left: ${bc.onionPercent}%;">
            <span class="ws-onion__grip">⇔</span>
          </div>
          <span class="ws-onion__label ws-onion__label--left">${escapeHtml(bc.a)}</span>
          <span class="ws-onion__label ws-onion__label--right">${escapeHtml(bc.b)}</span>
        </div>`
      : `<div class="ws-diff-highlight__stack">
          ${renderShot(shotUrl(branch, route, bc.a, bc.b, 'after'), bc.b)}
          ${bc.overlayVisible ? renderShot(shotUrl(branch, route, bc.a, bc.b, 'diff'), 'differences', 'ws-shot--overlay') : ''}
        </div>`;

  return `<div class="ws-diff">
      <div class="ws-toolbar">
        <span class="ws-toolbar__branch">Compare browsers</span>
        ${browserSelect('a', bc.a)}<span class="ws-bc-vs">vs</span>${browserSelect('b', bc.b)}
        <span class="ws-toolbar__route ws-mono" title="${escapeHtml(route)}">${escapeHtml(route)}</span>
        <span class="ws-toolbar__spacer"></span>
        <button type="button" class="ws-mini-button ${bc.mode === 'highlight' ? 'is-active' : ''}"
          data-action="ws-bc-mode" data-mode="highlight">Highlight</button>
        <button type="button" class="ws-mini-button ${bc.mode === 'onion' ? 'is-active' : ''}"
          data-action="ws-bc-mode" data-mode="onion">Onion</button>
        ${
          bc.mode === 'highlight'
            ? `<button type="button" class="ws-mini-button ${bc.overlayVisible ? 'is-active' : ''}"
                data-action="ws-bc-overlay-toggle">${bc.overlayVisible ? 'Hide diff' : 'Show diff'}</button>`
            : ''
        }
        <button type="button" class="ws-mini-button" data-action="ws-bc-close" title="Close comparison">✕</button>
      </div>
      <div class="ws-diff-body">${body}</div>
    </div>`;
};
