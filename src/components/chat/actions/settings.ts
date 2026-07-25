/**
 * Settings Actions
 *
 * Handles user settings persistence (theme, language) via PATCH /api/me
 * and sign-out. Auth is a same-origin session cookie — no tokens.
 */

import { store } from '../app/store';
import type { CommunicationModePreference, ThemeMode } from '../app/state';
import type { LocaleKey } from '../content';

// ─── Settings Persistence ────────────────────────────────────────────────────

/**
 * Persists user settings to the server profile.
 * Fire-and-forget from callers; failures are logged only.
 */
export const persistUserSettings = async (settings: {
  theme?: ThemeMode;
  language?: LocaleKey;
  communicationMode?: CommunicationModePreference;
}): Promise<void> => {
  if (!store.state.user) return;
  const res = await fetch('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/me failed with ${res.status}`);
  }
};

export const setCommunicationMode = async (
  communicationMode: CommunicationModePreference,
): Promise<void> => {
  const previous = store.state.communicationMode;
  store.state.communicationMode = communicationMode;
  store.notify();
  try {
    await persistUserSettings({ communicationMode });
  } catch (error) {
    store.state.communicationMode = previous;
    store.notify();
    console.error('[settings] Failed to persist communication mode', error);
  }
};

// ─── Sign Out ────────────────────────────────────────────────────────────────

/**
 * Signs the user out (server-side session) and navigates to the sign-in page.
 */
export const handleSignOut = async (): Promise<void> => {
  try {
    await fetch('/api/auth/sign-out', { method: 'POST' });
  } catch (error) {
    console.error('[settings] Sign out request failed', error);
  }
  store.reset();
  if (typeof window !== 'undefined') {
    window.location.href = '/signin/';
  }
};
