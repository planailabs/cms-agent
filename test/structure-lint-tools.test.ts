import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerStructureTools, outlineFile } from '@/lib/agent/tools/structureTools';
import { registerLintTools, detectLinters } from '@/lib/agent/tools/lintTools';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';

registerStructureTools();
registerLintTools();

let repo: string;

const ctx = (): ToolContext => ({
  chatId: 'c',
  branchId: 'b',
  branchName: 'test',
  userId: 'u',
  workflowPhase: 'plan',
    chatKind: 'workflow',
  worktreePath: repo,
  userContext: new Map(),
  modifiedPaths: new Set(),
});

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-struct-'));
  fs.mkdirSync(path.join(repo, 'src', 'pages', 'blog'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'layouts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'content', 'blog'), { recursive: true });

  fs.writeFileSync(
    path.join(repo, 'src', 'components', 'Card.astro'),
    `---
import Badge from './Badge.astro';
const { title, href } = Astro.props;
---
<a href={href}><h3>{title}</h3><Badge /></a>
`,
  );
  fs.writeFileSync(path.join(repo, 'src', 'components', 'Badge.astro'), '<span>new</span>');
  fs.writeFileSync(
    path.join(repo, 'src', 'pages', 'index.astro'),
    `---
import Card from '../components/Card.astro';
import Layout from '../layouts/Base.astro';
---
<Layout><h1>Home</h1><Card title="x" href="/x/" /></Layout>
`,
  );
  fs.writeFileSync(path.join(repo, 'src', 'layouts', 'Base.astro'), '<html><slot /></html>');
  fs.writeFileSync(path.join(repo, 'src', 'pages', 'blog', '[slug].astro'), '<html></html>');
  fs.writeFileSync(
    path.join(repo, 'src', 'content', 'blog', 'post.md'),
    '---\ntitle: Post\ndate: 2026-01-01\n---\n# Hello\n## Sub\n',
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'util.ts'),
    `export function formatDate(d: Date): string { return d.toISOString(); }\nexport const SITE_NAME = 'Acme';\n`,
  );
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { astro: '^6' } }));
});

describe('code_outline / outlineFile', () => {
  it('outlines an astro component with props, imports, and used components', () => {
    const o = outlineFile(repo, 'src/components/Card.astro');
    expect(o.imports).toEqual([{ names: 'Badge', from: './Badge.astro' }]);
    expect(o.props).toEqual(['title', 'href']);
    expect(o.componentsUsed).toContain('Badge');
  });

  it('outlines markdown frontmatter and headings', () => {
    const o = outlineFile(repo, 'src/content/blog/post.md');
    expect(o.frontmatterKeys).toEqual(['title', 'date']);
    expect(o.headings).toEqual(['Hello', '  Sub']);
  });

  it('outlines ts exports and functions', () => {
    const o = outlineFile(repo, 'src/util.ts');
    expect(o.exports).toEqual(expect.arrayContaining(['formatDate', 'SITE_NAME']));
    expect(o.functions).toContain('formatDate');
  });
});

describe('site_structure', () => {
  it('maps pages to routes and tracks component usage', async () => {
    const res = JSON.parse(await executeTool('site_structure', {}, ctx()));
    const routes = Object.fromEntries(res.pages.map((p: { file: string; route: string }) => [p.file, p.route]));
    expect(routes['src/pages/index.astro']).toBe('/');
    expect(routes['src/pages/blog/[slug].astro']).toContain('(dynamic)');
    expect(res.contentCollections).toEqual(['blog']);
    expect(res.componentUsage.Card).toContain('src/pages/index.astro');
    expect(res.componentUsage.Badge).toContain('src/components/Card.astro');
    expect(res.dependencies.astro).toBe('^6');
  });
});

describe('find_symbol', () => {
  it('finds definitions and usages', async () => {
    const res = JSON.parse(await executeTool('find_symbol', { name: 'formatDate' }, ctx()));
    expect(res.definitions.some((d: string) => d.startsWith('src/util.ts'))).toBe(true);

    const card = JSON.parse(await executeTool('find_symbol', { name: 'Card' }, ctx()));
    expect(card.definitions).toContain('src/components/Card.astro (file)');
    expect(card.usages.some((u: string) => u.startsWith('src/pages/index.astro'))).toBe(true);
  });
});

describe('lint tools', () => {
  it('detects the absence of linters and reports it instead of failing', async () => {
    expect(detectLinters(repo)).toEqual({
      eslint: false,
      prettier: false,
      astroCheck: false,
      lintScript: null,
    });
    const res = JSON.parse(await executeTool('lint', { tool: 'auto' }, ctx()));
    expect(res.note).toMatch(/no matching linter/);
  });

  it('detects linters from deps and config files', () => {
    fs.writeFileSync(path.join(repo, 'eslint.config.js'), 'export default [];');
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        scripts: { lint: 'eslint .' },
        devDependencies: { prettier: '^3', '@astrojs/check': '^0.9' },
      }),
    );
    expect(detectLinters(repo)).toEqual({
      eslint: true,
      prettier: true,
      astroCheck: true,
      lintScript: 'eslint .',
    });
  });

  it('rejects lint_fix outside the execute phase', async () => {
    const res = await executeTool('lint_fix', {}, ctx());
    expect(JSON.parse(res).error).toMatch(/not allowed in the plan phase/);
  });
});
