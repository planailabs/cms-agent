/**
 * Catalog: server-rendered pages (sign-in). Keys are namespaced `pages.*`.
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
  },
  de: {
    'pages.signin.title': 'Anmelden — CMS',
    'pages.signin.heading': 'CMS Agent',
    'pages.signin.description': 'Melde dich mit deinem Organisationskonto an, um fortzufahren.',
    'pages.signin.button': 'Anmelden',
    'pages.signin.failed': 'Anmeldung fehlgeschlagen.',
    'pages.signin.failedNetwork': 'Anmeldung fehlgeschlagen — ist der Identity Provider erreichbar?',
  },
};
