import { store } from '../app/store';
import { delegateEvent } from '../utils/dom';
import { cycleThemeMode } from '../actions/theme';
import { type LocaleKey } from '../content/index';
import { persistLocaleSelection } from '../app/state';
import { persistLanguagePreference } from '../actions/profile';
import { handleSignOut } from '../actions/settings';
import { openSettingsOverlay } from '../actions/overlay';

export const registerHeaderEvents = (app: HTMLElement) => {
  // Header: Theme Toggle
  delegateEvent(app, 'click', '[data-action="theme-toggle"]', () => {
    cycleThemeMode();
    // Persist handled inside setThemeMode (sessionStorage + PATCH /api/me).
  });

  // Header: Language Toggle
  delegateEvent(app, 'click', '[data-action="language-toggle"]', (event) => {
    event.stopPropagation();
    const state = store.state;
    store.setState({
      isAuthMenuOpen: false,
      isLanguageMenuOpen: !state.isLanguageMenuOpen,
    });
  });

  // Header: Language Selection
  delegateEvent(
    app,
    'click',
    '[data-action="language-select"]',
    (event, target) => {
      event.stopPropagation();
      const selectedLocale = target.getAttribute('data-locale') as LocaleKey;
      const state = store.state;
      if (selectedLocale && selectedLocale !== state.localeKey) {
        // document lang FIRST — the setState render pass resolves uiLocale()
        // from it (e.g. the preview toolbar); setting it afterwards leaves
        // those regions in the previous language until an unrelated render.
        persistLocaleSelection(selectedLocale);
        store.setState({
          localeKey: selectedLocale,
          isLanguageMenuOpen: false,
        });
        persistLanguagePreference(selectedLocale);
      } else {
        store.setState({ isLanguageMenuOpen: false });
      }
    },
  );

  // Header: User Menu Toggle
  delegateEvent(app, 'click', '[data-action="user-menu-toggle"]', (event) => {
    event.stopPropagation();
    const state = store.state;
    store.setState({
      isLanguageMenuOpen: false,
      isAuthMenuOpen: !state.isAuthMenuOpen,
    });
  });

  // Header: Settings Link
  delegateEvent(app, 'click', '[data-action="settings-link"]', (event) => {
    event.stopPropagation();
    store.setState({ isAuthMenuOpen: false });
    openSettingsOverlay();
  });

  // Header: Sign Out
  delegateEvent(app, 'click', '[data-action="sign-out"]', (event) => {
    event.stopPropagation();
    store.setState({ isAuthMenuOpen: false });
    void handleSignOut();
  });
};
