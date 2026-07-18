/**
 * i18n — flat message catalogs (en/de) shared by server and client.
 *
 * Two use cases:
 *  - UI strings: `t(uiLocale(), 'workspace.publish')` at render time.
 *  - Persisted chat messages: build a TranslatedMessage with `tmsg(key,
 *    params)` (stores key + params + rendered-English fallback), render it
 *    per viewer with `resolveTranslated(locale, tm)`. Params may nest another
 *    TranslatedMessage; it resolves in the viewer's locale too.
 */
import type { AreaCatalogs, Catalog, LocaleKey, MessageParams, TranslatedMessage } from './types';
import { automatismCatalogs } from './automatism';
import { chatCatalogs } from './chat';
import { workspaceCatalogs } from './workspace';
import { dashboardCatalogs } from './dashboard';
import { pagesCatalogs } from './pages';

export type { Catalog, LocaleKey, MessageParams, TranslatedMessage } from './types';

export const SUPPORTED_LOCALES: LocaleKey[] = ['en', 'de'];
export const DEFAULT_LOCALE: LocaleKey = 'en';

const areas: AreaCatalogs[] = [
  automatismCatalogs,
  chatCatalogs,
  workspaceCatalogs,
  dashboardCatalogs,
  pagesCatalogs,
];
const catalogs: Record<LocaleKey, Catalog> = { en: {}, de: {} };
for (const area of areas) {
  for (const locale of SUPPORTED_LOCALES) Object.assign(catalogs[locale], area[locale]);
}

export const normalizeLocale = (value: string | null | undefined): LocaleKey =>
  SUPPORTED_LOCALES.includes(value as LocaleKey) ? (value as LocaleKey) : DEFAULT_LOCALE;

/** English language names for the system prompt ("Respond ONLY in German"). */
const LANGUAGE_NAMES: Record<LocaleKey, string> = { en: 'English', de: 'German (Deutsch)' };
export const languageName = (locale: string): string => LANGUAGE_NAMES[normalizeLocale(locale)];

export const isTranslatedMessage = (value: unknown): value is TranslatedMessage =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TranslatedMessage).i18n === 'string' &&
  typeof (value as TranslatedMessage).fallback === 'string';

const interpolate = (locale: LocaleKey, template: string, params?: MessageParams): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const param = params?.[name];
    if (param === undefined) return whole;
    return isTranslatedMessage(param) ? resolveTranslated(locale, param) : String(param);
  });

/** Catalog lookup with {param} interpolation. Unknown keys render as the key. */
export function t(locale: string, key: string, params?: MessageParams): string {
  const l = normalizeLocale(locale);
  const template = catalogs[l][key] ?? catalogs.en[key];
  return template === undefined ? key : interpolate(l, template, params);
}

/** Build a TranslatedMessage; the fallback is the rendered English text. */
export function tmsg(key: string, params?: MessageParams): TranslatedMessage {
  return { i18n: key, ...(params ? { params } : {}), fallback: t('en', key, params) };
}

/** Render for a viewer: live catalog first, stored English fallback otherwise. */
export function resolveTranslated(locale: string, msg: TranslatedMessage): string {
  const l = normalizeLocale(locale);
  const template = catalogs[l][msg.i18n] ?? catalogs.en[msg.i18n];
  return template === undefined ? msg.fallback : interpolate(l, template, msg.params);
}

/**
 * Current UI locale on the client. Source of truth is <html lang>: rendered
 * server-side from User.language and kept in sync by the language menu
 * (persistLocaleSelection) and profile load.
 */
export const uiLocale = (): LocaleKey =>
  typeof document === 'undefined'
    ? DEFAULT_LOCALE
    : normalizeLocale(document.documentElement.lang.slice(0, 2));
