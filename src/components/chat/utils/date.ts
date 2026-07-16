/**
 * Date Formatting Utilities
 *
 * Provides locale-aware date formatting using the Intl API.
 */

import type { LocaleKey } from '../content';

/** Mapping from app locale keys to BCP 47 language tags */
const LOCALE_TAG_MAP: Record<LocaleKey, string> = {
  en: 'en-US',
  de: 'de-DE',
} as const;

/** Cached formatters to avoid repeated construction */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Gets or creates a cached DateTimeFormat instance.
 * Caching improves performance when formatting multiple dates.
 */
const getFormatter = (localeKey: LocaleKey): Intl.DateTimeFormat => {
  const tag = LOCALE_TAG_MAP[localeKey];
  let formatter = formatterCache.get(tag);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(tag, { dateStyle: 'long' });
    formatterCache.set(tag, formatter);
  }
  return formatter;
};

/**
 * Formats a timestamp into a localized date string.
 *
 * @param timestamp - Unix timestamp in milliseconds, or null
 * @param localeKey - The locale to use for formatting
 * @returns Formatted date string, or null if timestamp is falsy
 *
 * @example
 * getLocaleDateString(1700000000000, 'en') // "November 14, 2023"
 * getLocaleDateString(1700000000000, 'de') // "14. November 2023"
 */
export const getLocaleDateString = (
  timestamp: number | null | undefined,
  localeKey: LocaleKey,
): string | null => {
  if (!timestamp) {
    return null;
  }
  try {
    return getFormatter(localeKey).format(new Date(timestamp));
  } catch {
    // Fallback to ISO format if Intl fails
    return new Date(timestamp).toISOString().split('T')[0];
  }
};
