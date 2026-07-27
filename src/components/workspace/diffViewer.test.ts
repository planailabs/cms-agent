import { describe, expect, it } from 'vitest';
import {
  canonicalDiffRoute,
  normalizeDiffRoute,
  resolveDiffRoute,
  routeKey,
} from './diffViewer';
import { createInitialDiffState } from './state';
import type { DiffPage } from './state';

const page = (route: string): DiffPage => ({ route, file: `src/pages${route}.astro` });

describe('normalizeDiffRoute', () => {
  it('normalizes to a route-shaped pathname, preserving trailing slashes', () => {
    expect(normalizeDiffRoute('/about')).toBe('/about');
    expect(normalizeDiffRoute('/blog/future-of-ai/')).toBe('/blog/future-of-ai/');
    expect(normalizeDiffRoute('about')).toBe('/about');
    expect(normalizeDiffRoute(' /about ')).toBe('/about');
    expect(normalizeDiffRoute('/about?x=1#top')).toBe('/about');
    expect(normalizeDiffRoute('/')).toBe('/');
    expect(normalizeDiffRoute('')).toBe('/');
  });
});

describe('routeKey', () => {
  it('treats trailing-slash variants as the same page', () => {
    expect(routeKey('/blog/future-of-ai/')).toBe(routeKey('/blog/future-of-ai'));
    expect(routeKey('/')).toBe('/');
    expect(routeKey('//')).toBe('/');
    expect(routeKey('/a')).not.toBe(routeKey('/b'));
  });
});

describe('canonicalDiffRoute', () => {
  it('maps a browsed slash variant onto the existing changed-page tab', () => {
    const pages = [page('/'), page('/blog/future-of-ai')];
    expect(canonicalDiffRoute(pages, '/blog/future-of-ai/')).toBe('/blog/future-of-ai');
    // …and the other way around when the pages list carries the slash
    expect(canonicalDiffRoute([page('/blog/future-of-ai/')], '/blog/future-of-ai')).toBe(
      '/blog/future-of-ai/',
    );
    // off-list routes keep their own (site-served) form
    expect(canonicalDiffRoute(pages, '/contact/')).toBe('/contact/');
  });
});

describe('resolveDiffRoute', () => {
  it('prefers the selected route, falls back to the first page, then null', () => {
    const diff = createInitialDiffState();
    expect(resolveDiffRoute(diff)).toBeNull();
    diff.pages = [page('/'), page('/about')];
    expect(resolveDiffRoute(diff)).toBe('/');
    diff.selectedRoute = '/contact'; // free-browsed route outside the list
    expect(resolveDiffRoute(diff)).toBe('/contact');
  });
});
