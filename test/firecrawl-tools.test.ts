import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FirecrawlNative } from '@/lib/firecrawl/native';
import type { ToolContext } from '@/lib/agent/tools/registry';

const native = {
  transformHtml: vi.fn(async () => '<main>clean</main>'),
  extractBaseHref: vi.fn(async () => 'https://example.com/'),
  extractLinks: vi.fn(async () => ['https://example.com/a']),
  extractMetadata: vi.fn(async () => ({ title: 'Example' })),
  getInnerJson: vi.fn(async () => 'inner'),
  extractAttributes: vi.fn(async () => []),
  extractImages: vi.fn(async () => []),
  postProcessMarkdown: vi.fn(async (value: string) => value.trim()),
  filterLinks: vi.fn(async () => ({ links: [] })),
  filterUrl: vi.fn(async () => ({ allowed: true })),
  parseSitemapXml: vi.fn(async () => ({})),
  processSitemap: vi.fn(async () => ({ instructions: [] })),
  computeEngpickerVerdict: vi.fn(async () => ({ verdict: 'TlsClientOk' })),
  processPdf: vi.fn(() => ({ markdown: '# PDF', pageCount: 1 })),
  detectPdf: vi.fn(() => ({ pdfType: 'TextBased' })),
  DocumentType: { Doc: 0, Docx: 1, Rtf: 2, Odt: 3, Xlsx: 4 },
  DocumentConverter: class { convertBufferToHtml() { return '<p>document</p>'; } },
} as unknown as FirecrawlNative;

vi.mock('@/lib/firecrawl/native', async (original) => ({
  ...(await original<typeof import('@/lib/firecrawl/native')>()),
  firecrawlNative: () => native,
}));

vi.mock('@/lib/firecrawl/web', () => ({
  scrapeWeb: vi.fn(async () => ({ url: 'https://example.com/', html: '<main>page</main>' })),
  searchWeb: vi.fn(async () => [{ url: 'https://example.com/', title: 'Example', description: 'Result' }]),
  mapWeb: vi.fn(async () => ['https://example.com/']),
  crawlWeb: vi.fn(async () => [{ url: 'https://example.com/', html: '<main>page</main>' }]),
}));

vi.mock('@/lib/firecrawl/fetch', async (original) => ({
  ...(await original<typeof import('@/lib/firecrawl/fetch')>()),
  fetchPublic: vi.fn(async () => ({
    body: Buffer.from('<html>raw</html>'), status: 200, url: 'https://example.com/', headers: {},
  })),
}));

const { executeTool, toolsForPhase } = await import('@/lib/agent/tools/registry');
const { registerFirecrawlTools } = await import('@/lib/agent/tools/firecrawlTools');
registerFirecrawlTools();

let repo: string;
const ctx = (phase: ToolContext['workflowPhase']): ToolContext => ({
  chatId: 'chat', branchId: 'branch', branchName: 'main', userId: 'user',
  workflowPhase: phase, chatKind: 'workflow', worktreePath: repo,
  userContext: new Map(), modifiedPaths: new Set(),
});

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-firecrawl-tools-'));
  fs.writeFileSync(path.join(repo, 'input.html'), '<html><body>source</body></html>');
});

describe('Firecrawl agent tools', () => {
  it('exposes every native operation and service-style web operation in every phase', () => {
    const expected = [
      'firecrawl_extract_base_href', 'firecrawl_extract_links', 'firecrawl_extract_metadata',
      'firecrawl_transform_html', 'firecrawl_get_inner_text', 'firecrawl_extract_attributes',
      'firecrawl_extract_images', 'firecrawl_post_process_markdown', 'firecrawl_filter_links',
      'firecrawl_filter_url', 'firecrawl_parse_sitemap', 'firecrawl_process_sitemap',
      'firecrawl_compute_engpicker_verdict', 'firecrawl_detect_pdf', 'firecrawl_process_pdf',
      'firecrawl_convert_document', 'web_fetch_raw', 'web_fetch_firecrawl',
      'web_scrape', 'web_search', 'web_map', 'web_crawl',
    ];
    for (const phase of ['plan', 'execute', 'preview', 'published'] as const) {
      const names = toolsForPhase(phase).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(expected));
    }
  });

  it('reads and writes by jailed paths without returning large content', async () => {
    const context = ctx('plan');
    const transformed = JSON.parse(await executeTool('firecrawl_transform_html', {
      inputPath: 'input.html', outputPath: 'artifacts/clean.html', url: 'https://example.com/',
    }, context));
    expect(transformed).toEqual({ path: 'artifacts/clean.html', bytes: 18 });
    expect(fs.readFileSync(path.join(repo, 'artifacts/clean.html'), 'utf8')).toBe('<main>clean</main>');
    expect(context.modifiedPaths).toContain('artifacts/clean.html');
    expect(JSON.parse(await executeTool('firecrawl_transform_html', {
      inputPath: '../escape.html', outputPath: 'x', url: 'https://example.com/',
    }, context)).error).toMatch(/escapes the repository/);
  });

  it('writes browser scrape and search results to files', async () => {
    const context = ctx('published');
    expect(JSON.parse(await executeTool('web_scrape', {
      url: 'https://example.com/', outputPath: 'web/page.html',
    }, context))).toMatchObject({ path: 'web/page.html' });
    expect(JSON.parse(await executeTool('web_search', {
      query: 'example', outputPath: 'web/search.json',
    }, context))).toMatchObject({ path: 'web/search.json', count: 1 });
    expect(fs.readFileSync(path.join(repo, 'web/page.html'), 'utf8')).toContain('page');
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'web/search.json'), 'utf8')).web).toHaveLength(1);
  });
});
