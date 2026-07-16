import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectionsAdapter,
  loadRelatedEntries,
  parseFrontmatter,
  suggestRelated,
  validateCollectionEntry,
  type RelatedEntry,
} from '@/lib/content/collections';

describe('frontmatter parser', () => {
  it('parses scalars, quoted strings and ISO dates (kept as strings)', () => {
    const { data, body } = parseFrontmatter(
      [
        '---',
        'title: "Hello: World"',
        "subtitle: 'Single quoted'",
        'plain: Just text',
        'count: 42',
        'draft: false',
        'date: 2026-03-15',
        '---',
        'Body here.',
      ].join('\n'),
    );
    expect(data).toEqual({
      title: 'Hello: World',
      subtitle: 'Single quoted',
      plain: 'Just text',
      count: 42,
      draft: false,
      date: '2026-03-15',
    });
    expect(body.trim()).toBe('Body here.');
  });

  it('parses arrays in both inline and block syntax', () => {
    const { data } = parseFrontmatter(
      ['---', 'tags: [astro, "content management", cms]', 'categories:', '  - guides', '  - news', '---', ''].join(
        '\n',
      ),
    );
    expect(data?.tags).toEqual(['astro', 'content management', 'cms']);
    expect(data?.categories).toEqual(['guides', 'news']);
  });

  it('tolerates broken input', () => {
    // no frontmatter at all
    expect(parseFrontmatter('# Just markdown').data).toBeNull();
    // unterminated block
    expect(parseFrontmatter('---\ntitle: x\nno end').data).toBeNull();
    // garbage lines inside the block are skipped, valid lines kept
    const { data } = parseFrontmatter('---\ntitle: ok\n%% not yaml at all\n# comment\n---\n');
    expect(data).toEqual({ title: 'ok' });
  });
});

// ─── fixture tree ─────────────────────────────────────────────────────────────

let repo: string;

function writeEntry(rel: string, content: string): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-content-test-'));
  writeEntry(
    'src/content/blog/first-post.md',
    [
      '---',
      'title: "First Post"',
      'date: 2026-01-05',
      'tags: [astro, cms]',
      'description: Intro to the CMS agent',
      '---',
      '# First Post',
      'Body text.',
    ].join('\n'),
  );
  writeEntry(
    'src/content/blog/second-post.md',
    ['---', 'title: Second Post', 'date: 2026-02-10', 'tags:', '  - astro', '  - deploy', '---', 'Deploying.'].join(
      '\n',
    ),
  );
  writeEntry(
    'src/content/blog/third-post.md',
    ['---', 'title: Third Post', 'date: 2026-03-01', 'tags: [design]', 'draft: true', '---', 'Design notes.'].join(
      '\n',
    ),
  );
  writeEntry('src/content/docs/setup.md', ['---', 'title: Setup', '---', 'Install steps.'].join('\n'));
  writeEntry('src/content/docs/usage.md', ['---', 'title: Usage', '---', 'How to use.'].join('\n'));
});

describe('collections inventory', () => {
  it('finds collections, entry counts, field union and required-by-convention fields', async () => {
    const inv = await collectionsAdapter.inventory(repo);
    expect(inv.adapter).toBe('content-collections');
    expect(inv.collections.map((c) => c.name)).toEqual(['blog', 'docs']);

    const blog = inv.collections[0];
    expect(blog.entryCount).toBe(3);
    expect(blog.dir).toBe(path.join('src', 'content', 'blog'));
    expect(blog.exampleEntry).toBe(path.join('src', 'content', 'blog', 'first-post.md'));

    const byName = Object.fromEntries(blog.fields.map((f) => [f.name, f]));
    expect(Object.keys(byName).sort()).toEqual(['date', 'description', 'draft', 'tags', 'title']);
    expect(byName.title.required).toBe(true);
    expect(byName.date.required).toBe(true);
    expect(byName.tags.required).toBe(true);
    expect(byName.description.required).toBe(false);
    expect(byName.draft.required).toBe(false);
    expect(byName.tags.example).toBe('[astro, cms]');
  });

  it('buildContext is compact and mentions collections + conventions', async () => {
    const ctx = await collectionsAdapter.buildContext(repo);
    expect(ctx.length).toBeLessThanOrEqual(2000);
    expect(ctx).toContain('"blog"');
    expect(ctx).toContain('kebab-case');
    expect(ctx).toContain('required by convention');
  });
});

describe('collections validate', () => {
  const validate = (rel: string) => validateCollectionEntry(repo, rel);

  it('ignores files outside content collections', () => {
    writeEntry('src/pages/about.md', 'no frontmatter');
    expect(validate(path.join('src', 'pages', 'about.md'))).toEqual([]);
  });

  it('errors on missing/unterminated frontmatter', () => {
    const rel = path.join('src', 'content', 'blog', 'no-frontmatter.md');
    writeEntry(rel, '# Just a heading\nNo frontmatter.');
    const issues = validate(rel);
    expect(issues.some((i) => i.severity === 'error' && /frontmatter/i.test(i.message))).toBe(true);
    fs.rmSync(path.join(repo, rel));
  });

  it('errors when a required-by-convention field is missing', () => {
    const rel = path.join('src', 'content', 'blog', 'new-entry.md');
    writeEntry(rel, ['---', 'title: New Entry', 'tags: [astro]', '---', 'text'].join('\n'));
    const issues = validate(rel);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('"date"'))).toBe(true);
    fs.rmSync(path.join(repo, rel));
  });

  it('errors on invalid ISO dates in date-looking fields', () => {
    const rel = path.join('src', 'content', 'blog', 'bad-date.md');
    writeEntry(rel, ['---', 'title: Bad', 'date: 2026-13-99', 'tags: [x]', '---', 'text'].join('\n'));
    const issues = validate(rel);
    expect(issues.some((i) => i.severity === 'error' && /valid ISO date/.test(i.message))).toBe(true);
    fs.rmSync(path.join(repo, rel));
  });

  it('warns on non-kebab-case filenames', () => {
    const rel = path.join('src', 'content', 'blog', 'My_NewPost.md');
    writeEntry(rel, ['---', 'title: Cased', 'date: 2026-05-01', 'tags: [x]', '---', 'text'].join('\n'));
    const issues = validate(rel);
    expect(issues.some((i) => i.severity === 'warning' && /kebab-case/.test(i.message))).toBe(true);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    fs.rmSync(path.join(repo, rel));
  });

  it('passes a conforming entry cleanly', () => {
    const rel = path.join('src', 'content', 'blog', 'clean-entry.md');
    writeEntry(rel, ['---', 'title: Clean', 'date: 2026-06-01', 'tags: [astro]', '---', 'text'].join('\n'));
    expect(validate(rel)).toEqual([]);
    fs.rmSync(path.join(repo, rel));
  });
});

describe('suggestRelated', () => {
  const entries: RelatedEntry[] = [
    { path: 'blog/a.md', title: 'Astro deployment guide', tags: ['astro', 'deploy'], date: '2026-01-01' },
    { path: 'blog/b.md', title: 'Astro content collections', tags: ['astro', 'cms'], date: '2026-02-01' },
    { path: 'blog/c.md', title: 'Cooking pasta', tags: ['food'], date: '2026-03-01' },
    { path: 'blog/cur.md', title: 'Astro deployment tips', tags: ['astro', 'deploy'], date: '2026-04-01' },
  ];
  const current = entries[3];

  it('weights shared tags (3) over token overlap (1), excludes current and unrelated', () => {
    const result = suggestRelated(entries, current);
    expect(result.map((r) => r.path)).toEqual(['blog/a.md', 'blog/b.md']);
    // a: 2 shared tags (6) + tokens astro, deployment (2) = 8
    expect(result[0].score).toBe(8);
    // b: 1 shared tag (3) + token astro (1) = 4
    expect(result[1].score).toBe(4);
    expect(result[0].reasons.join(' ')).toMatch(/shared tags/);
    expect(result.some((r) => r.path === 'blog/cur.md')).toBe(false);
    expect(result.some((r) => r.path === 'blog/c.md')).toBe(false);
  });

  it('is deterministic', () => {
    const shuffled = [entries[2], entries[0], entries[3], entries[1]];
    expect(suggestRelated(entries, current)).toEqual(suggestRelated(shuffled, current));
    expect(suggestRelated(entries, current)).toEqual(suggestRelated(entries, current));
  });

  it('breaks score ties by recency, then path', () => {
    const tied: RelatedEntry[] = [
      { path: 'blog/old.md', title: 'x', tags: ['t'], date: '2025-01-01' },
      { path: 'blog/new.md', title: 'x', tags: ['t'], date: '2026-01-01' },
      { path: 'blog/me.md', title: 'me', tags: ['t'], date: '2026-06-01' },
    ];
    const result = suggestRelated(tied, tied[2]);
    expect(result.map((r) => r.path)).toEqual(['blog/new.md', 'blog/old.md']);
  });

  it('filters out entries in another locale', () => {
    const localized: RelatedEntry[] = [
      { path: 'blog/de.md', title: 'Astro Anleitung', tags: ['astro'], locale: 'de' },
      { path: 'blog/en.md', title: 'Astro guide', tags: ['astro'], locale: 'en' },
      { path: 'blog/cur.md', title: 'Astro tips', tags: ['astro'], locale: 'en' },
    ];
    const result = suggestRelated(localized, localized[2]);
    expect(result.map((r) => r.path)).toEqual(['blog/en.md']);
  });

  it('respects max', () => {
    expect(suggestRelated(entries, current, 1)).toHaveLength(1);
  });
});

describe('loadRelatedEntries', () => {
  it('maps frontmatter into RelatedEntry records', () => {
    const entries = loadRelatedEntries(repo, 'blog');
    expect(entries).toHaveLength(3);
    const first = entries.find((e) => e.path.endsWith('first-post.md'))!;
    expect(first.title).toBe('First Post');
    expect(first.tags).toEqual(['astro', 'cms']);
    expect(first.date).toBe('2026-01-05');
  });
});
