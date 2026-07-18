/**
 * i18n core types. This module is imported from both server code and
 * client-rendered components — keep it free of node/browser dependencies.
 */

/** Two-letter UI locale. New languages: extend here and in every catalog file. */
export type LocaleKey = 'en' | 'de';

/** Params may nest a TranslatedMessage — it resolves in the viewer's locale. */
export type MessageParam = string | number | TranslatedMessage;
export type MessageParams = Record<string, MessageParam>;

/**
 * Locale-independent container for persisted chat messages: the catalog key,
 * its parameters, and the fully rendered English text captured at creation
 * time. Rendering prefers the live catalog (viewer's language); the fallback
 * keeps old messages readable after a catalog key is renamed or dropped.
 */
export interface TranslatedMessage {
  i18n: string;
  params?: MessageParams;
  fallback: string;
}

/** Flat key → template map; templates interpolate `{param}` placeholders. */
export type Catalog = Record<string, string>;

/** One catalog per supported locale — every catalog area file exports this. */
export type AreaCatalogs = Record<LocaleKey, Catalog>;
