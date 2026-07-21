/**
 * Header Component
 *
 * Renders the application header with:
 * - App name and version badge
 * - Theme toggle
 * - Language selector dropdown
 * - User menu (settings, sign out)
 */

import {
  locales,
  supportedLocales,
  type LocaleKey,
  type LocaleContent,
} from '../content';
import type { AppState } from '../app/state';
import { store } from '../app/store';
import { APP_NAME, getAppBuild } from '../constants';
import { t, uiLocale } from '@/lib/i18n';

/**
 * Counter for unique SVG mask IDs to prevent DOM conflicts.
 * Uses modulo to prevent unbounded growth in long-running sessions.
 */
let globeMaskCounter = 0;
const MAX_MASK_ID = 10000;

// ─────────────────────────────────────────────────────────────────────────────
// Theme Utilities
// ─────────────────────────────────────────────────────────────────────────────

type ColorScheme = 'light' | 'dark';

const getSystemPreference = (): ColorScheme => {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
};

// ─────────────────────────────────────────────────────────────────────────────
// SVG Icons
// ─────────────────────────────────────────────────────────────────────────────

const ICON_CLASS = 'icon-size';

/** Theme toggle icon - visual state reflects current mode */
const getThemeIconSvg = (): string => {
  const currentMode = store.state.themeMode;
  const systemPref = getSystemPreference();
  const firstManual = systemPref === 'dark' ? 'light' : 'dark';

  // System mode: half-filled circle
  if (currentMode === 'system') {
    return `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>
    </svg>`;
  }

  // First manual mode (opposite of system): empty circle
  if (currentMode === firstManual) {
    return `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5" fill="none"/>
    </svg>`;
  }

  // Second manual mode: filled circle
  return `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8" fill="currentColor" stroke="currentColor" stroke-width="1.5"/>
  </svg>`;
};

/** Language/globe icon with masked cutout for globe effect */
const getLanguageIconSvg = (): string => {
  globeMaskCounter = (globeMaskCounter + 1) % MAX_MASK_ID;
  const maskId = `globe-cutout-${globeMaskCounter}`;
  return `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <mask id="${maskId}">
        <rect width="24" height="24" fill="white"/>
        <ellipse cx="12" cy="12" rx="8" ry="11" fill="black"/>
        <ellipse cx="12" cy="12" rx="5" ry="9" fill="white"/>
        <rect x="2" y="11" width="20" height="2" fill="black"/>
      </mask>
    </defs>
    <circle cx="12" cy="12" r="10" fill="currentColor" mask="url(#${maskId})"/>
  </svg>`;
};

/** User avatar placeholder icon */
const getUserIconSvg =
  (): string => `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="8" r="3.5" fill="currentColor"/>
  <path d="M5 19c0-3.032 2.686-5 7-5s7 1.968 7 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

// ─────────────────────────────────────────────────────────────────────────────
// Dropdown Renderers
// ─────────────────────────────────────────────────────────────────────────────

interface LanguageOption {
  key: LocaleKey;
  name: string;
}

const getLanguageOptions = (): LanguageOption[] =>
  supportedLocales.map((key) => ({
    key,
    name: locales[key].languageNativeName,
  }));

const CHECK_ICON_SVG = `<svg class="check-icon" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M6 12.5l3.5 3.5 8-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const renderLanguageOptions = (currentLocale: LocaleKey): string =>
  getLanguageOptions()
    .map(({ key, name }) => {
      const isSelected = currentLocale === key;
      return `<button
        type="button"
        class="dropdown-option"
        data-action="language-select"
        data-locale="${key}"
        role="menuitemradio"
        aria-checked="${isSelected}">
        <span>${name}</span>
        ${isSelected ? CHECK_ICON_SVG : ''}
      </button>`;
    })
    .join('');

// ─────────────────────────────────────────────────────────────────────────────
// Header Component
// ─────────────────────────────────────────────────────────────────────────────

interface HeaderParams {
  locale: LocaleContent;
  state: AppState;
}

const buildClassList = (...classes: (string | false | undefined)[]): string =>
  classes.filter(Boolean).join(' ');

export const renderHeader = ({ locale, state }: HeaderParams): string => {
  const { navigation } = locale;
  const appBuild = getAppBuild(); // version/commit from the authed #app dataset

  // Build conditional class lists
  const languageToggleClasses = buildClassList(
    'icon-button',
    !state.isLanguageMenuOpen && 'tooltip',
  );

  const avatarToggleClasses = buildClassList(
    'icon-button',
    'avatar-button',
    !state.isAuthMenuOpen && 'tooltip',
  );

  // Build tooltip attributes (only when menu is closed)
  const languageTooltipAttr = state.isLanguageMenuOpen
    ? ''
    : `data-tooltip="${navigation.languageMenu.tooltip}"`;

  const avatarTooltipAttr = state.isAuthMenuOpen
    ? ''
    : `data-tooltip="${navigation.settingsLabel}"`;

  // Avatar content: /api/me has no avatar URL, so always show the fallback icon
  const avatarContent = `<span class="avatar-shell avatar-fallback">${getUserIconSvg()}</span>`;

  // Dropdown menus
  const languageDropdown = state.isLanguageMenuOpen
    ? `<div class="dropdown-panel" role="menu">
        <div class="flex flex-col gap-1">${renderLanguageOptions(state.localeKey)}</div>
      </div>`
    : '';

  // Admin-only dashboard link (plain anchor; /dashboard/ is server-guarded)
  const dashboardOption =
    state.user?.role === 'admin'
      ? `<a class="dropdown-option" href="/dashboard/" role="menuitem">
          <span>${t(uiLocale(), 'chat.header.dashboard')}</span>
        </a>`
      : '';

  const userDropdown = state.isAuthMenuOpen
    ? `<div class="dropdown-panel" role="menu">
        <div class="flex flex-col gap-1">
          ${dashboardOption}
          <button type="button" class="dropdown-option" data-action="settings-link">
            <span>${navigation.settingsLabel}</span>
          </button>
          <button type="button" class="dropdown-option" data-action="sign-out">
            <span>${navigation.signOutLabel}</span>
          </button>
        </div>
      </div>`
    : '';

  // Mobile: px-4 py-4, Desktop: px-8 py-6
  return `<header class="flex w-full items-center justify-between px-4 py-4 md:px-8 md:py-6">
    <span class="logo-link flex items-center gap-2 text-base font-semibold tracking-tight text-(--text-primary) md:text-lg">
      <span class="flex items-baseline gap-2 leading-none">
        <span>${APP_NAME}</span>
        <span class="text-[0.5em] font-bold text-(--text-muted)">${appBuild.version}${appBuild.commit ? ` <span class="font-normal">${appBuild.commit}</span>` : ''}</span>
      </span>
    </span>

    <div class="flex items-center gap-3 text-sm text-(--text-muted) md:gap-[14px]">
      <div class="relative">
        <button
          class="icon-button tooltip"
          type="button"
          data-action="theme-toggle"
          data-tooltip="${navigation.themeToggle.tooltip}"
          aria-label="${navigation.themeToggle.label}">
          ${getThemeIconSvg()}
        </button>
      </div>

      <div class="relative" data-menu="language">
        <button
          class="${languageToggleClasses}"
          type="button"
          data-action="language-toggle"
          aria-label="${navigation.languageMenu.label}"
          aria-haspopup="menu"
          aria-expanded="${state.isLanguageMenuOpen}"
          ${languageTooltipAttr}>
          ${getLanguageIconSvg()}
        </button>
        ${languageDropdown}
      </div>

      <div class="relative" data-menu="auth">
        <button
          class="${avatarToggleClasses}"
          type="button"
          data-action="user-menu-toggle"
          aria-haspopup="menu"
          aria-expanded="${state.isAuthMenuOpen}"
          ${avatarTooltipAttr}>
          ${avatarContent}
        </button>
        ${userDropdown}
      </div>
    </div>
  </header>`;
};
