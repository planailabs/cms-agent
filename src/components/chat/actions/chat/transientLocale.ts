import { store } from '../../app/store';
import { supportedLocales, type LocaleKey } from '../../content';

/** Apply a live SSE language hint without persisting it or replaying it from history. */
export const applyTransientUiLanguage = (locale: unknown, userId: unknown): boolean => {
  if (userId !== store.state.user?.id || !supportedLocales.includes(locale as LocaleKey)) {
    return false;
  }
  store.state.localeKey = locale as LocaleKey;
  document.documentElement.lang = locale as LocaleKey;
  store.notify();
  return true;
};
