import { describe, expect, it } from 'vitest';
import { parseRouteMappings, resolveChangedPages } from '@/lib/diff/routes';

describe('file → route mapping', () => {
  it('maps src/pages by Astro conventions', () => {
    const { pages, unresolved } = resolveChangedPages(
      [
        'src/pages/index.astro',
        'src/pages/about.astro',
        'src/pages/jobs/index.md',
        'src/pages/blog/[slug].astro',
        'src/components/Header.astro',
      ],
      [],
      [],
    );
    expect(pages.map((p) => p.route).sort()).toEqual(['/', '/about/', '/jobs/']);
    expect(unresolved).toEqual(['src/pages/blog/[slug].astro']);
  });

  it('applies ROUTE_MAPPINGS for content collections', () => {
    const mappings = parseRouteMappings(
      JSON.stringify([{ files: 'src/content/blog/*.md', route: '/blog/:slug' }]),
    );
    const { pages, unresolved } = resolveChangedPages(
      ['src/content/blog/hello-world.md', 'src/content/other/x.md'],
      [],
      mappings,
    );
    expect(pages).toEqual([{ route: '/blog/hello-world/', file: 'src/content/blog/hello-world.md' }]);
    expect(unresolved).toEqual(['src/content/other/x.md']);
  });

  it('supports ** globs and merges planned urls', () => {
    const mappings = parseRouteMappings(
      JSON.stringify([{ files: 'src/content/**/*.md', route: '/c/:slug/' }]),
    );
    const { pages } = resolveChangedPages(
      ['src/content/a/deep/nested.md'],
      ['https://x.example/extra', '/about'],
      mappings,
    );
    expect(pages.map((p) => p.route).sort()).toEqual(['/about/', '/c/nested/', '/extra/']);
  });

  it('tolerates malformed ROUTE_MAPPINGS', () => {
    expect(parseRouteMappings('not json')).toEqual([]);
    expect(parseRouteMappings('{"a":1}')).toEqual([]);
    expect(parseRouteMappings(undefined)).toEqual([]);
  });
});
