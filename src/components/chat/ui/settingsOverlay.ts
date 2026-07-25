/**
 * Settings Overlay Component
 *
 * Renders the settings modal with:
 * - User profile section (name, email)
 * - Sign out button
 */

import type { AppState } from '../app/state';
import type { LocaleContent } from '../content';
import { escapeHtml } from '../utils/html';
import { t, uiLocale } from '@/lib/i18n';

/** Placeholder user icon for users without avatars */
const userIcon = () => `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8" r="4" fill="currentColor" />
    <path
      d="M5 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />
  </svg>
`;

export const renderSettingsOverlay = (params: {
  state: AppState;
  locale: LocaleContent;
}) => {
  const { state, locale } = params;
  if (!state.isSettingsOverlayOpen) {
    return '';
  }
  const displayName =
    state.user?.name?.trim() ||
    state.user?.email ||
    locale.settings.sections.profile.fields.name;
  const email = state.user?.email ?? t(uiLocale(), 'chat.settings.notSignedIn');
  const avatar = `<span class="settings-avatar-fallback">${userIcon()}</span>`;
  const closeLabel = t(uiLocale(), 'chat.settings.closeOverlay');
  const signOutDisabled = state.user ? '' : 'disabled';
  const profileSection = locale.settings.sections.profile;
  const communicationMode = state.communicationMode;
  const defaultModeLabel = t(
    uiLocale(),
    state.defaultCommunicationMode === 'technical'
      ? 'chat.settings.mode.technical'
      : 'chat.settings.mode.nonTechnical',
  );

  return `
    <div class="settings-overlay" data-settings-root>
      <button class="settings-overlay__backdrop" data-action="close-settings" aria-label="${escapeHtml(closeLabel)}"></button>
      <section class="settings-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(locale.settings.title)}">
        <button type="button" class="settings-close-button" data-action="close-settings" aria-label="${escapeHtml(t(uiLocale(), 'chat.settings.close'))}">
          <span aria-hidden="true">&times;</span>
        </button>
        <div class="settings-identity">
          <div class="settings-avatar">
            ${avatar}
          </div>
          <div class="settings-identity__text">
            <p class="settings-display-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</p>
            <p class="settings-email" title="${escapeHtml(email)}">${escapeHtml(email)}</p>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <section class="settings-section">
          <header class="settings-section__header">
            <p class="settings-section__title">${escapeHtml(
              profileSection.title,
            )}</p>
          </header>
        </section>
        <div class="settings-divider" aria-hidden="true"></div>
        <section class="settings-section">
          <header class="settings-section__header">
            <p class="settings-section__title">${escapeHtml(t(uiLocale(), 'chat.settings.mode.title'))}</p>
          </header>
          <p class="settings-section__subtitle">${escapeHtml(t(uiLocale(), 'chat.settings.mode.description'))}</p>
          <label class="settings-field">
            <span>${escapeHtml(t(uiLocale(), 'chat.settings.mode.label'))}</span>
            <select class="settings-select" data-action="communication-mode">
              <option value="default"${communicationMode === 'default' ? ' selected' : ''}>${escapeHtml(t(uiLocale(), 'chat.settings.mode.default', { mode: defaultModeLabel }))}</option>
              <option value="non-technical"${communicationMode === 'non-technical' ? ' selected' : ''}>${escapeHtml(t(uiLocale(), 'chat.settings.mode.nonTechnical'))}</option>
              <option value="technical"${communicationMode === 'technical' ? ' selected' : ''}>${escapeHtml(t(uiLocale(), 'chat.settings.mode.technical'))}</option>
            </select>
          </label>
        </section>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="settings-actions">
          <button type="button" class="pill-button" data-action="overlay-sign-out" ${signOutDisabled}>
            ${escapeHtml(locale.navigation.signOutLabel)}
          </button>
        </div>
      </section>
    </div>
  `;
};
