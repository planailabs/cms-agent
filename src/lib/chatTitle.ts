/**
 * The placeholder title a chat carries until the agent names it.
 *
 * It is stored, so it shows up in the sidebar exactly as written — a German
 * session listing "New chat" is the one piece of app chrome the language
 * switch could not reach. It is written in the creator's language instead, and
 * "has the agent named this chat yet?" asks this module rather than comparing
 * against one hard-coded English string.
 */
import { SUPPORTED_LOCALES, t } from '@/lib/i18n';

/** Placeholder for a chat created by a speaker of `locale`. */
export const defaultChatTitle = (locale: string): string => t(locale, 'chat.defaultTitle');

/** Every placeholder we have ever written, so an old row still counts as
 *  unnamed after the catalogs grow a language. */
const PLACEHOLDERS = new Set<string>([
  'New chat', // pre-i18n rows
  ...SUPPORTED_LOCALES.map((l) => t(l, 'chat.defaultTitle')),
]);

export const isDefaultChatTitle = (title: string | null | undefined): boolean =>
  !!title && PLACEHOLDERS.has(title.trim());
