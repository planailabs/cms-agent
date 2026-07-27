/**
 * Cross-browser comparison overlay — renders the current route in two browser
 * engines (via /api/preview/browsers-shot) and compares them with the same
 * highlight/onion widgets the diff viewer uses. Shown in the main area in
 * both the PREVIEW phase and regular preview mode.
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import { store } from '../chat/app/store';
import type { AppState } from '../chat/app/state';
import type { BrowserName } from './state';
import { previewBranchName } from './preview';
import { registerWindow } from './window';
import { MODE_ICONS } from './diffViewer';

/** Browser engine names are brand names — not translated. */
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
  kind: 'before' | 'after' | 'diff' | 'before-aligned' | 'after-aligned',
): string =>
  `/api/preview/browsers-shot?branch=${encodeURIComponent(branch)}` +
  `&route=${encodeURIComponent(route)}&a=${a}&b=${b}&kind=${kind}`;

const renderShot = (src: string, alt: string, extraClass = '', extraStyle = '', attrs = ''): string =>
  `<div class="ws-shot ${extraClass}" ${extraStyle ? `style="${extraStyle}"` : ''} ${attrs}>
    <span class="ws-shot__spinner"><span class="ws-spinner"></span> ${escapeHtml(t(uiLocale(), 'workspace.bc.renderingShot', { name: alt }))}</span>
    <img data-shot src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false" />
  </div>`;

const browserSelect = (which: 'a' | 'b', selected: BrowserName): string =>
  `<select class="dash-input ws-bc-select" data-action="ws-bc-browser" data-which="${which}">
    ${BROWSERS.map(
      (o) => `<option value="${o.key}" ${o.key === selected ? 'selected' : ''}>${o.label}</option>`,
    ).join('')}
  </select>`;

export const renderBrowserCompare = (state: AppState): string => {
  const locale = uiLocale();
  const bc = state.workspace.browserCompare;
  const branch = previewBranchName(state);
  const route = state.workspace.previewRoute;

  // Content mode uses server-aligned shots produced by real DOM reflow; height
  // mode uses the raw shots. Both onion and scroll consume the same pair.
  const content = state.workspace.compareMode === 'content';
  const bk = content ? 'before-aligned' : 'before';
  const ak = content ? 'after-aligned' : 'after';
  const body =
    bc.mode === 'onion'
      ? `<div class="ws-onion">
          <div class="ws-onion__canvas">
            ${renderShot(shotUrl(branch, route, bc.a, bc.b, bk), bc.a, 'ws-onion__before')}
            ${renderShot(
              shotUrl(branch, route, bc.a, bc.b, ak),
              bc.b,
              'ws-onion__after',
              `clip-path: inset(0 0 0 ${bc.onionPercent}%);`,
            )}
            <div class="ws-onion__slider" data-action="ws-bc-onion-handle" style="left: ${bc.onionPercent}%;">
              <span class="ws-onion__grip">⇔</span>
            </div>
            <span class="ws-onion__label ws-onion__label--left">${escapeHtml(bc.a)}</span>
            <span class="ws-onion__label ws-onion__label--right">${escapeHtml(bc.b)}</span>
          </div>
        </div>`
      : bc.mode === 'scroll'
        ? // Side-by-side scroll: ONE scroll container, both (aligned) shots as
          // columns — pre-aligned server-side, so they scroll in lockstep.
          `<div class="ws-bc-scroll">
            ${renderShot(shotUrl(branch, route, bc.a, bc.b, bk), bc.a, 'ws-onion__before')}
            ${renderShot(shotUrl(branch, route, bc.a, bc.b, ak), bc.b, 'ws-onion__after')}
            <span class="ws-onion__label ws-onion__label--left">${escapeHtml(bc.a)}</span>
            <span class="ws-onion__label ws-onion__label--right">${escapeHtml(bc.b)}</span>
          </div>`
        : `<div class="ws-diff-highlight__stack">
          ${renderShot(
            shotUrl(branch, route, bc.a, bc.b, 'after'),
            bc.b,
            '',
            '',
            bc.overlayVisible
              ? `data-boxhl data-before="${escapeHtml(shotUrl(branch, route, bc.a, bc.b, 'before'))}" data-after="${escapeHtml(shotUrl(branch, route, bc.a, bc.b, 'after'))}"`
              : '',
          )}
        </div>`;

  // Same icon segmented control as the diff viewer's mode switch (redesign)
  const modeButton = (mode: 'highlight' | 'onion' | 'scroll', icon: string, labelKey: string) =>
    `<button type="button" class="ws-seg__btn ${bc.mode === mode ? 'is-active' : ''}"
      data-action="ws-bc-mode" data-mode="${mode}"
      title="${escapeHtml(t(locale, labelKey))}" aria-label="${escapeHtml(t(locale, labelKey))}">${icon}</button>`;

  return `<div class="ws-diff">
      <div class="ws-toolbar">
        <span class="ws-chrome-dots" aria-hidden="true"><i></i><i></i></span>
        <span class="ws-toolbar__branch">${escapeHtml(t(locale, 'workspace.bc.heading'))}</span>
        ${browserSelect('a', bc.a)}<span class="ws-bc-vs">${escapeHtml(t(locale, 'workspace.bc.vs'))}</span>${browserSelect('b', bc.b)}
        <span class="ws-toolbar__route ws-mono" title="${escapeHtml(route)}">${escapeHtml(route)}</span>
        <span class="ws-toolbar__spacer"></span>
        <div class="ws-seg">
          ${modeButton('highlight', MODE_ICONS.highlight, 'workspace.diff.mode.highlight')}
          ${modeButton('onion', MODE_ICONS.onion, 'workspace.diff.mode.onion')}
          ${modeButton('scroll', MODE_ICONS['side-by-side'], 'workspace.diff.mode.sideBySide')}
        </div>
        ${
          bc.mode === 'highlight'
            ? `<button type="button" class="ws-mini-button ${bc.overlayVisible ? 'is-active' : ''}"
                data-action="ws-bc-overlay-toggle">${escapeHtml(t(locale, bc.overlayVisible ? 'workspace.bc.hideDiff' : 'workspace.bc.showDiff'))}</button>`
            : `<button type="button" class="ws-mini-button ${state.workspace.compareMode === 'content' ? 'is-active' : ''}"
                data-action="ws-compare-align" title="${escapeHtml(t(locale, 'workspace.compare.title'))}">${escapeHtml(t(locale, state.workspace.compareMode === 'content' ? 'workspace.compare.content' : 'workspace.compare.height'))}</button>`
        }
        <button type="button" class="ws-mini-button" data-action="ws-bc-close" title="${escapeHtml(t(locale, 'workspace.bc.closeTitle'))}">✕</button>
      </div>
      <div class="ws-diff-body">${body}</div>
    </div>`;
};

registerWindow({
  kind: 'browsers',
  order: 10,
  icon: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M1.8 6h12.4"/><circle cx="4.2" cy="4.4" r="0.45" fill="currentColor" stroke="none"/></svg>`,
  tooltipKey: 'workspace.preview.browsersTitle',
  railAction: 'ws-bc-open',
  render: renderBrowserCompare,
  capture: (state) => ({
    a: state.workspace.browserCompare.a,
    b: state.workspace.browserCompare.b,
    mode: state.workspace.browserCompare.mode,
  }),
  restore: (data) => {
    const d = data as { a?: string; b?: string; mode?: string };
    const bc = store.state.workspace.browserCompare;
    const names = ['chromium', 'firefox', 'webkit'];
    if (d.a && names.includes(d.a)) bc.a = d.a as BrowserName;
    if (d.b && names.includes(d.b)) bc.b = d.b as BrowserName;
    if (d.mode && ['highlight', 'onion', 'scroll'].includes(d.mode)) bc.mode = d.mode as typeof bc.mode;
  },
});
