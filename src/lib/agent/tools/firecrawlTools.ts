import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fetchPublic, MAX_FETCH_BYTES } from '@/lib/firecrawl/fetch';
import {
  FIRECRAWL_DOCUMENT_TYPES,
  firecrawlNative,
} from '@/lib/firecrawl/native';
import { crawlWeb, mapWeb, scrapeWeb, searchWeb } from '@/lib/firecrawl/web';
import { jail } from './fsTools';
import { registerTool, type ToolContext, type ToolDef } from './registry';

const ALL_PHASES = ['plan', 'execute', 'preview', 'published'] as const;
const inputPathSchema = z.object({ inputPath: z.string() });

function readText(ctx: ToolContext, file: string): string {
  return fs.readFileSync(jail(ctx, file), 'utf8');
}

function write(ctx: ToolContext, file: string, data: string | Buffer): number {
  const destination = jail(ctx, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data);
  ctx.modifiedPaths.add(file);
  return Buffer.byteLength(data);
}

function result(value: unknown): string {
  return JSON.stringify(value);
}

const nativeTools: ToolDef[] = [
  {
    name: 'firecrawl_extract_base_href',
    description: 'Resolve an HTML file base URL using Firecrawl native parsing.',
    schema: inputPathSchema.extend({ url: z.string().url() }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result({ baseUrl: await firecrawlNative().extractBaseHref(readText(ctx, input.inputPath), input.url) });
    },
  },
  {
    name: 'firecrawl_extract_links',
    description: 'Extract links from an HTML file with Firecrawl native parsing.',
    schema: inputPathSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(await firecrawlNative().extractLinks(readText(ctx, input.inputPath)));
    },
  },
  {
    name: 'firecrawl_extract_metadata',
    description: 'Extract page metadata from an HTML file with Firecrawl native parsing.',
    schema: inputPathSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(await firecrawlNative().extractMetadata(readText(ctx, input.inputPath)));
    },
  },
  {
    name: 'firecrawl_transform_html',
    description: 'Clean an HTML file with Firecrawl and write the transformed HTML to a repo path.',
    schema: inputPathSchema.extend({
      outputPath: z.string(),
      url: z.string().url(),
      includeTags: z.array(z.string()).default([]),
      excludeTags: z.array(z.string()).default([]),
      onlyMainContent: z.boolean().default(true),
    }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const html = await firecrawlNative().transformHtml({
        html: readText(ctx, input.inputPath),
        url: input.url,
        includeTags: input.includeTags,
        excludeTags: input.excludeTags,
        onlyMainContent: input.onlyMainContent,
      });
      return result({ path: input.outputPath, bytes: write(ctx, input.outputPath, html) });
    },
  },
  {
    name: 'firecrawl_get_inner_text',
    description: 'Extract body text from an HTML file and write it to a repo path.',
    schema: inputPathSchema.extend({ outputPath: z.string() }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const text = await firecrawlNative().getInnerJson(readText(ctx, input.inputPath));
      return result({ path: input.outputPath, bytes: write(ctx, input.outputPath, text) });
    },
  },
  {
    name: 'firecrawl_extract_attributes',
    description: 'Extract selected HTML attributes from a file.',
    schema: inputPathSchema.extend({
      selectors: z.array(z.object({ selector: z.string(), attribute: z.string() })).min(1),
    }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(
        await firecrawlNative().extractAttributes(readText(ctx, input.inputPath), {
          selectors: input.selectors,
        }),
      );
    },
  },
  {
    name: 'firecrawl_extract_images',
    description: 'Extract and resolve image URLs from an HTML file.',
    schema: inputPathSchema.extend({ baseUrl: z.string().url() }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(await firecrawlNative().extractImages(readText(ctx, input.inputPath), input.baseUrl));
    },
  },
  {
    name: 'firecrawl_post_process_markdown',
    description: 'Post-process a Markdown file with Firecrawl and write the result to a repo path.',
    schema: inputPathSchema.extend({ outputPath: z.string() }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const markdown = await firecrawlNative().postProcessMarkdown(readText(ctx, input.inputPath));
      return result({ path: input.outputPath, bytes: write(ctx, input.outputPath, markdown) });
    },
  },
  {
    name: 'firecrawl_filter_links',
    description: 'Run Firecrawl crawl-link filtering using a JSON input file.',
    schema: inputPathSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(await firecrawlNative().filterLinks(JSON.parse(readText(ctx, input.inputPath))));
    },
  },
  {
    name: 'firecrawl_filter_url',
    description: 'Run Firecrawl single-URL filtering using a JSON input file.',
    schema: inputPathSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(await firecrawlNative().filterUrl(JSON.parse(readText(ctx, input.inputPath))));
    },
  },
  {
    name: 'firecrawl_parse_sitemap',
    description: 'Parse a sitemap XML file with Firecrawl native parsing.',
    schema: inputPathSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(await firecrawlNative().parseSitemapXml(readText(ctx, input.inputPath)));
    },
  },
  {
    name: 'firecrawl_process_sitemap',
    description: 'Turn a sitemap XML file into Firecrawl crawl instructions.',
    schema: inputPathSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(await firecrawlNative().processSitemap(readText(ctx, input.inputPath)));
    },
  },
  {
    name: 'firecrawl_compute_engpicker_verdict',
    description: 'Compare browser and TLS scrape results from a JSON file and choose a Firecrawl engine.',
    schema: inputPathSchema.extend({
      similarityThreshold: z.number().min(0).max(1).default(0.9),
      successRateThreshold: z.number().min(0).max(1).default(0.8),
      cdpFailureThreshold: z.number().min(0).max(1).default(0.3),
    }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const data = JSON.parse(readText(ctx, input.inputPath)) as Record<string, unknown>[];
      return result(
        await firecrawlNative().computeEngpickerVerdict(
          data,
          input.similarityThreshold,
          input.successRateThreshold,
          input.cdpFailureThreshold,
        ),
      );
    },
  },
  {
    name: 'firecrawl_detect_pdf',
    description: 'Detect PDF type and metadata from a PDF file without extracting all text.',
    schema: inputPathSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      return result(firecrawlNative().detectPdf(jail(ctx, input.inputPath)));
    },
  },
  {
    name: 'firecrawl_process_pdf',
    description: 'Extract a PDF to Markdown with Firecrawl, writing Markdown to a repo path.',
    schema: inputPathSchema.extend({
      outputPath: z.string(),
      maxPages: z.number().int().positive().optional(),
    }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const processed = firecrawlNative().processPdf(jail(ctx, input.inputPath), input.maxPages);
      const markdown = typeof processed.markdown === 'string' ? processed.markdown : '';
      const { markdown: _markdown, ...metadata } = processed;
      return result({ ...metadata, path: input.outputPath, bytes: write(ctx, input.outputPath, markdown) });
    },
  },
  {
    name: 'firecrawl_convert_document',
    description: 'Convert a DOC, DOCX, RTF, ODT, or XLSX file to HTML and write it to a repo path.',
    schema: inputPathSchema.extend({ outputPath: z.string() }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const extension = path.extname(input.inputPath).toLowerCase() as keyof typeof FIRECRAWL_DOCUMENT_TYPES;
      const typeName = FIRECRAWL_DOCUMENT_TYPES[extension];
      if (!typeName) throw new Error(`Unsupported document type: ${extension || '(none)'}`);
      const native = firecrawlNative();
      const html = new native.DocumentConverter().convertBufferToHtml(
        fs.readFileSync(jail(ctx, input.inputPath)),
        native.DocumentType[typeName],
      );
      return result({ path: input.outputPath, bytes: write(ctx, input.outputPath, html) });
    },
  },
];

const fetchSchema = z.object({
  url: z.string().url(),
  outputPath: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  maxBytes: z.number().int().positive().max(MAX_FETCH_BYTES).default(MAX_FETCH_BYTES),
});

const scrapeOptionsSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  includeTags: z.array(z.string()).default([]),
  excludeTags: z.array(z.string()).default([]),
  onlyMainContent: z.boolean().default(true),
  waitFor: z.number().int().nonnegative().max(30_000).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
  mobile: z.boolean().optional(),
});

const traverseSchema = z.object({
  url: z.string().url(),
  outputPath: z.string(),
  limit: z.number().int().positive().optional(),
  maxDiscoveryDepth: z.number().int().nonnegative().max(10).optional(),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional(),
  allowExternalLinks: z.boolean().default(false),
  allowSubdomains: z.boolean().default(false),
  ignoreQueryParameters: z.boolean().default(false),
  ignoreRobotsTxt: z.boolean().default(false),
  scrapeOptions: scrapeOptionsSchema.default({}),
});

const webTools: ToolDef[] = [
  {
    name: 'web_scrape',
    description: 'Render a public page in Chromium, clean it with Firecrawl, and write its HTML to a repo path.',
    schema: scrapeOptionsSchema.extend({ url: z.string().url(), outputPath: z.string() }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const document = await scrapeWeb(input.url, input);
      return result({
        ...document,
        html: undefined,
        path: input.outputPath,
        bytes: write(ctx, input.outputPath, document.html ?? ''),
      });
    },
  },
  {
    name: 'web_search',
    description: 'Search the public web and write structured web results to a JSON file.',
    schema: z.object({
      query: z.string().min(1),
      outputPath: z.string(),
      limit: z.number().int().min(1).max(30).default(5),
      includeDomains: z.array(z.string()).optional(),
      excludeDomains: z.array(z.string()).optional(),
      language: z.string().default('en'),
      country: z.string().default('us'),
      timeout: z.number().int().positive().max(120_000).optional(),
    }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const results = await searchWeb(input);
      return result({
        path: input.outputPath,
        count: results.length,
        bytes: write(ctx, input.outputPath, JSON.stringify({ web: results }, null, 2)),
      });
    },
  },
  {
    name: 'web_map',
    description: 'Discover links from a public site with browser rendering and write them to JSON.',
    schema: traverseSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const links = await mapWeb(input.url, { ...input, ...input.scrapeOptions });
      return result({
        path: input.outputPath,
        count: links.length,
        bytes: write(ctx, input.outputPath, JSON.stringify({ links: links.map((url) => ({ url })) }, null, 2)),
      });
    },
  },
  {
    name: 'web_crawl',
    description: 'Crawl and render public site pages, writing Firecrawl-cleaned documents to JSON.',
    schema: traverseSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const documents = await crawlWeb(input.url, { ...input, ...input.scrapeOptions });
      return result({
        path: input.outputPath,
        count: documents.length,
        bytes: write(ctx, input.outputPath, JSON.stringify({ data: documents }, null, 2)),
      });
    },
  },
  {
    name: 'web_fetch_raw',
    description: 'Fetch a public HTTP(S) URL as-is and write its exact response bytes to a repo path.',
    schema: fetchSchema,
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const fetched = await fetchPublic(input.url, input);
      return result({
        path: input.outputPath,
        bytes: write(ctx, input.outputPath, fetched.body),
        status: fetched.status,
        url: fetched.url,
        headers: fetched.headers,
      });
    },
  },
  {
    name: 'web_fetch_firecrawl',
    description: 'Fetch a public web page, clean it with Firecrawl, and write the main-content HTML to a repo path.',
    schema: fetchSchema.extend({
      includeTags: z.array(z.string()).default([]),
      excludeTags: z.array(z.string()).default([]),
      onlyMainContent: z.boolean().default(true),
    }),
    phases: [...ALL_PHASES],
    async execute(input, ctx) {
      const fetched = await fetchPublic(input.url, input);
      const source = fetched.body.toString('utf8');
      const native = firecrawlNative();
      const html = await native.transformHtml({
        html: source,
        url: fetched.url,
        includeTags: input.includeTags,
        excludeTags: input.excludeTags,
        onlyMainContent: input.onlyMainContent,
      });
      const [metadata, links, images] = await Promise.all([
        native.extractMetadata(source),
        native.extractLinks(source),
        native.extractImages(source, fetched.url),
      ]);
      return result({
        path: input.outputPath,
        bytes: write(ctx, input.outputPath, html),
        status: fetched.status,
        url: fetched.url,
        metadata,
        links,
        images,
      });
    },
  },
];

export function registerFirecrawlTools(): void {
  for (const tool of [...nativeTools, ...webTools]) registerTool(tool);
}
