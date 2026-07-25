import { describe, expect, it } from 'vitest';
import { parseRouteMappings, resolveChangedPages } from '@/lib/diff/routes';
import { affectedGraphRoutes } from '@/lib/preview/routeGraph';
import { staticBackend } from '@/lib/site/static';

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

  it('finds routes through before and after dependency graphs', () => {
    const before = {
      routes: [
        {
          route: '/old',
          entrypoint: 'src/pages/old.astro',
          sources: ['src/pages/old.astro', 'src/components/Removed.astro'],
        },
      ],
    };
    const after = {
      routes: [
        {
          route: '/new/',
          entrypoint: 'src/pages/new.astro',
          sources: ['src/pages/new.astro', 'src/components/Added.astro'],
        },
      ],
    };
    const inferred = affectedGraphRoutes(
      ['src/components/Removed.astro', 'src/components/Added.astro'],
      [before, after],
    );
    const { pages } = resolveChangedPages([], [], [], inferred);

    expect(pages).toEqual([
      { route: '/old/', file: 'src/components/Removed.astro' },
      { route: '/new/', file: 'src/components/Added.astro' },
    ]);
  });

  it('maps static-backend html files by path and skips assets', () => {
    const { pages, unresolved } = resolveChangedPages(
      ['index.html', 'guides/index.html', 'about.html', 'style.css'],
      ['/planned'],
      [],
      [],
      staticBackend,
    );
    expect(pages.map((p) => p.route).sort()).toEqual(['/', '/about.html', '/guides/', '/planned/']);
    // css is neither a page nor unresolved site content
    expect(unresolved).toEqual([]);
  });

  it('applies ROUTE_MAPPINGS before path conventions for the static backend', () => {
    const mappings = parseRouteMappings(
      JSON.stringify([{ files: 'news/*.html', route: '/aktuelles/:slug' }]),
    );
    const { pages } = resolveChangedPages(['news/launch.html'], [], mappings, [], staticBackend);
    expect(pages).toEqual([{ route: '/aktuelles/launch/', file: 'news/launch.html' }]);
  });
});
