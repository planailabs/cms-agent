/**
 * Catalog: server-rendered pages (sign-in, preview boot). Keys are
 * namespaced `pages.*`.
 */
import type { AreaCatalogs } from './types';

export const pagesCatalogs: AreaCatalogs = {
  en: {
    'pages.signin.title': 'Sign in — CMS',
    'pages.signin.heading': 'CMS Agent',
    'pages.signin.description': 'Sign in with your organization account to continue.',
    'pages.signin.button': 'Sign in',
    'pages.signin.failed': 'Sign-in failed.',
    'pages.signin.failedNetwork': 'Sign-in failed — is the identity provider reachable?',
    'pages.preview.startingTitle': 'Starting preview…',
    'pages.preview.failedTitle': 'Preview failed',
    'pages.preview.starting': 'Starting preview for {branch} — this page reloads automatically…',
    'pages.preview.failed': 'Preview for {branch} failed to start:',
    'pages.preview.retry': 'Retry',
    'pages.preview.unknownBranch': 'Unknown branch {branch}.',
    'pages.preview.installing': 'Installing site dependencies…',
    'pages.preview.startingServer': 'Starting the dev server…',
  },
  de: {
    'pages.signin.title': 'Anmelden — CMS',
    'pages.signin.heading': 'CMS Agent',
    'pages.signin.description': 'Melde dich mit deinem Organisationskonto an, um fortzufahren.',
    'pages.signin.button': 'Anmelden',
    'pages.signin.failed': 'Anmeldung fehlgeschlagen.',
    'pages.signin.failedNetwork': 'Anmeldung fehlgeschlagen — ist der Identity Provider erreichbar?',
    'pages.preview.startingTitle': 'Vorschau startet…',
    'pages.preview.failedTitle': 'Vorschau fehlgeschlagen',
    'pages.preview.starting':
      'Vorschau für {branch} wird gestartet — diese Seite lädt automatisch neu…',
    'pages.preview.failed': 'Die Vorschau für {branch} konnte nicht gestartet werden:',
    'pages.preview.retry': 'Erneut versuchen',
    'pages.preview.unknownBranch': 'Unbekannter Branch {branch}.',
    'pages.preview.installing': 'Website-Abhängigkeiten werden installiert…',
    'pages.preview.startingServer': 'Der Dev-Server wird gestartet…',
  },
};
