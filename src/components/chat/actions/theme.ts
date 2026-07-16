/**
 * Theme Actions
 *
 * Handles theme mode switching (system/light/dark):
 * - Applies theme to document
 * - Persists to sessionStorage
 * - Syncs to user profile (PATCH /api/me)
 * - Listens for system preference changes
 */

import { store } from '../app/store';
import { persistUserSettings } from './settings';
import { STORAGE_KEYS } from '../constants';

export type ThemeMode = 'system' | 'light' | 'dark';

// ─────────────────────────────────────────────────────────────────────────────
// System Preference Detection
// ─────────────────────────────────────────────────────────────────────────────

/** Media query for detecting system dark mode preference */
const prefersDark =
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

const getSystemPreference = (): 'light' | 'dark' =>
  prefersDark?.matches ? 'dark' : 'light';

const applyDocumentTheme = (theme: 'light' | 'dark') => {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
};

export const initTheme = () => {
  // 1. Read from storage or default
  let mode: ThemeMode = 'system';
  try {
    const stored = sessionStorage.getItem(STORAGE_KEYS.THEME);
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      mode = stored;
    }
  } catch {
    // Ignore storage errors
  }

  // 2. Set initial state
  store.setState({ themeMode: mode });

  // 3. Apply to DOM immediately
  const effective = mode === 'system' ? getSystemPreference() : mode;
  applyDocumentTheme(effective);

  // 4. Listen for system changes
  prefersDark?.addEventListener('change', () => {
    if (store.state.themeMode === 'system') {
      applyDocumentTheme(getSystemPreference());
      store.notify(); // Re-render to update icons if needed
    }
  });
};

export const setThemeMode = (
  mode: ThemeMode,
  options?: { skipRemote?: boolean },
) => {
  store.setState({ themeMode: mode });

  // Update DOM
  const effective = mode === 'system' ? getSystemPreference() : mode;
  applyDocumentTheme(effective);

  // Persist to Session
  try {
    sessionStorage.setItem(STORAGE_KEYS.THEME, mode);
  } catch {
    // Ignore storage errors
  }

  // Persist to Profile (skipRemote is used when applying a server-provided value)
  if (!options?.skipRemote) {
    void persistUserSettings({ theme: mode }).catch((error) => {
      console.error('[settings] Failed to persist theme preference', error);
    });
  }
};

export const cycleThemeMode = () => {
  const current = store.state.themeMode;
  const systemPref = getSystemPreference();
  // Order: Light -> Dark -> System -> Light... (adjusted based on current system)
  // If system is Dark: System(Dark) -> Light -> Dark -> System
  // If system is Light: System(Light) -> Dark -> Light -> System

  // Simplified rotation for clarity:
  // If System (Dark) -> Light
  // If System (Light) -> Dark
  // If Light -> Dark
  // If Dark -> System

  let next: ThemeMode;

  if (current === 'system') {
    next = systemPref === 'dark' ? 'light' : 'dark';
  } else if (current === 'light') {
    next = 'dark';
  } else {
    next = 'system';
  }

  setThemeMode(next);
};
