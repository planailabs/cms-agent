/**
 * Profile Actions
 *
 * Loads the signed-in user from GET /api/me, applies server-side
 * preferences (theme, language) to app state, and persists language
 * changes back via PATCH /api/me.
 */

import { store } from '../app/store';
import { setThemeMode } from './theme';
import { persistUserSettings } from './settings';
import { cacheUserState, persistLocaleSelection } from '../app/state';
import type { ThemeMode } from '../app/state';
import type { CommunicationMode, CommunicationModePreference } from '../app/state';
import { supportedLocales, type LocaleKey } from '../content';

// ─── Load Profile ───────────────────────────────────────────────────────────

let loadPromise: Promise<void> | null = null;

/**
 * Loads the user profile from GET /api/me and applies it to state.
 * The app is behind server-side auth, so this is expected to succeed.
 */
export const loadProfile = (): Promise<void> => {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const res = await fetch('/api/me');
      if (!res.ok) {
        console.error('[profile] GET /api/me failed with', res.status);
        return;
      }
      const me = (await res.json()) as {
        id: string;
        email: string;
        name: string;
        role: string;
        theme?: string | null;
        language?: string | null;
        attachmentsOnePerMessage?: boolean;
        communicationMode?: CommunicationModePreference;
        defaultCommunicationMode?: CommunicationMode;
      };

      const state = store.state;
      state.user = { id: me.id, email: me.email, name: me.name, role: me.role };
      state.attachmentsOnePerMessage = !!me.attachmentsOnePerMessage;
      if (
        me.communicationMode === 'default' ||
        me.communicationMode === 'technical' ||
        me.communicationMode === 'non-technical'
      ) {
        state.communicationMode = me.communicationMode;
      }
      if (
        me.defaultCommunicationMode === 'technical' ||
        me.defaultCommunicationMode === 'non-technical'
      ) {
        state.defaultCommunicationMode = me.defaultCommunicationMode;
      }

      // Cache user state for instant header render on reload
      cacheUserState(state.user);

      // Apply language
      if (
        me.language &&
        supportedLocales.includes(me.language as LocaleKey) &&
        me.language !== state.localeKey
      ) {
        state.localeKey = me.language as LocaleKey;
        persistLocaleSelection(state.localeKey);
      }

      // Apply theme (skipRemote: the server value is already persisted)
      if (
        (me.theme === 'system' || me.theme === 'light' || me.theme === 'dark') &&
        me.theme !== state.themeMode
      ) {
        setThemeMode(me.theme as ThemeMode, { skipRemote: true });
      }

      store.notify();
    } catch (error) {
      console.error('[profile] Failed to load profile', error);
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
};

// ─── Persist Helpers ────────────────────────────────────────────────────────

export const persistLanguagePreference = (localeKey: LocaleKey) => {
  void persistUserSettings({ language: localeKey }).catch((error) => {
    console.error('[profile] Failed to persist language', error);
  });
};
