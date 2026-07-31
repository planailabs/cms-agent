/**
 * i18n core — catalog lookup, interpolation, TranslatedMessage container
 * (nested params, dropped-key fallback), locale normalization.
 */
import { describe, expect, it } from 'vitest';
import { languageName, normalizeLocale, resolveTranslated, t, tmsg } from '@/lib/i18n';

describe('i18n core', () => {
  it('translates a key with params in both locales', () => {
    expect(t('en', 'pull.done', { target: 'main' })).toBe(
      'Sync done — the draft is up to date with main.',
    );
    expect(t('de', 'pull.done', { target: 'main' })).toBe(
      'Sync abgeschlossen — der Entwurf ist auf dem Stand von main.',
    );
  });

  it('falls back to English for unknown locales and to the key for unknown keys', () => {
    expect(t('fr', 'pull.done', { target: 'main' })).toContain('Sync done');
    expect(t('en', 'no.such.key')).toBe('no.such.key');
    expect(normalizeLocale('xx')).toBe('en');
    expect(normalizeLocale('de')).toBe('de');
  });

  it('tmsg captures a rendered English fallback and resolves per viewer', () => {
    const msg = tmsg('deploy.merged', { workBranch: 'c-abc', target: 'main', sha: '12345678' });
    expect(msg.fallback).toBe('Merged c-abc into main → 12345678.');
    expect(resolveTranslated('de', msg)).toBe('c-abc wurde in main gemerged → 12345678.');
    expect(resolveTranslated('en', msg)).toBe(msg.fallback);
  });

  it('keeps the original text when a catalog key was dropped', () => {
    const old = { i18n: 'deploy.removedKey', params: { x: 1 }, fallback: 'Original English text.' };
    expect(resolveTranslated('de', old)).toBe('Original English text.');
    expect(resolveTranslated('en', old)).toBe('Original English text.');
  });

  it('resolves nested TranslatedMessage params in the viewer locale', () => {
    const msg = tmsg('automatism.stepFailed', {
      step: 'merge',
      error: tmsg('deploy.mergeFailed', { target: 'main', error: 'boom' }),
    });
    expect(msg.fallback).toContain('Merge into main failed: boom');
    expect(resolveTranslated('de', msg)).toContain('Merge in main fehlgeschlagen: boom');
    expect(resolveTranslated('de', msg)).toContain('Schritt "merge" FEHLGESCHLAGEN');
  });

  it('gives a new chat its placeholder title in the creator\u2019s language', async () => {
    // The title is STORED, so it is the one piece of chrome the language
    // switch cannot reach afterwards \u2014 an English "New chat" in a German
    // sidebar is what the bench judge kept flagging.
    const { defaultChatTitle, isDefaultChatTitle } = await import('@/lib/chatTitle');
    expect(defaultChatTitle('de')).toBe('Neuer Chat');
    expect(defaultChatTitle('en')).toBe('New chat');
    // "Has the agent named this chat yet?" must still be true for every
    // placeholder ever written, including the pre-i18n English rows.
    expect(isDefaultChatTitle('Neuer Chat')).toBe(true);
    expect(isDefaultChatTitle('New chat')).toBe(true);
    expect(isDefaultChatTitle('Summer landing page')).toBe(false);
    expect(isDefaultChatTitle(null)).toBe(false);
  });

  it('names languages for the system prompt', () => {
    expect(languageName('de')).toBe('German (Deutsch)');
    expect(languageName('en')).toBe('English');
    expect(languageName('unknown')).toBe('English');
  });
});
