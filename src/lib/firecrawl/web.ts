import { scrapeInBrowser, type BrowserScrapeOptions } from './browser';
import { fetchPublic } from './fetch';
import { firecrawlNative } from './native';

export interface WebDocument {
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  links?: string[];
  images?: string[];
  html?: string;
}

export interface ScrapeOptions extends BrowserScrapeOptions {
  includeTags?: string[];
  excludeTags?: string[];
  onlyMainContent?: boolean;
}

export async function scrapeWeb(url: string, options: ScrapeOptions = {}): Promise<WebDocument> {
  const rendered = await scrapeInBrowser(url, options);
  const native = firecrawlNative();
  const html = await native.transformHtml({
    html: rendered.html,
    url: rendered.url,
    includeTags: options.includeTags ?? [],
    excludeTags: options.excludeTags ?? [],
    onlyMainContent: options.onlyMainContent ?? true,
  });
  const [metadata, links, images] = await Promise.all([
    native.extractMetadata(rendered.html),
    native.extractLinks(rendered.html),
    native.extractImages(rendered.html, rendered.url),
  ]);
  return { url: rendered.url, title: rendered.title, metadata, links, images, html };
}

function text(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchResult {
  url: string;
  title: string;
  description: string;
}

function parseBing(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.match(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!link) continue;
    results.push({ url: link[1].replace(/&amp;/g, '&'), title: text(link[2]), description: text(snippet?.[1] ?? '') });
    if (results.length >= limit) break;
  }
  return results;
}

function parseBrave(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const pattern = /data-type="web"[\s\S]*?<a href="(https?:[^"#]+)"[^>]+class="[^"]*\bl1\b[^"]*"[\s\S]*?<div class="title search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div><\/a>[\s\S]*?<div class="generic-snippet[^"]*"[\s\S]*?<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  for (const match of html.matchAll(pattern)) {
    if (results.some((item) => item.url === match[1])) continue;
    results.push({ url: match[1].replace(/&amp;/g, '&'), title: text(match[2]), description: text(match[3]) });
    if (results.length >= limit) break;
  }
  return results;
}

export async function searchWeb(options: {
  query: string;
  limit?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  language?: string;
  country?: string;
  timeout?: number;
}): Promise<SearchResult[]> {
  const domainQuery = [
    ...(options.includeDomains ?? []).map((domain) => `site:${domain}`),
    ...(options.excludeDomains ?? []).map((domain) => `-site:${domain}`),
  ].join(' ');
  const params = new URLSearchParams({
    q: `${options.query} ${domainQuery}`.trim(),
    kp: '1',
    kl: `${options.country ?? 'us'}-${options.language ?? 'en'}`.toLowerCase(),
  });
  const searchHeaders = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': `${options.language ?? 'en'},en;q=0.5`,
  };
  const html = (await fetchPublic(`https://html.duckduckgo.com/html?${params}`, {
    headers: searchHeaders,
    timeoutMs: options.timeout ?? 15_000,
  })).body.toString('utf8');

  const results: SearchResult[] = [];
  const blocks = html.includes('anomaly-modal__modal')
    ? []
    : (html.match(/<div[^>]+class="[^"]*\bresult\b[^"]*\bweb-result\b[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi) ?? []);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\//i);
    if (!link || !snippet) continue;
    const redirect = new URL(link[1].replace(/&amp;/g, '&'), 'https://duckduckgo.com');
    const url = redirect.searchParams.get('uddg') ?? redirect.href;
    if (results.some((item) => item.url === url)) continue;
    results.push({ url, title: text(link[2]), description: text(snippet[1]) });
    if (results.length >= (options.limit ?? 5)) break;
  }
  if (results.length) return results;

  const fallbackQuery = `${options.query} ${domainQuery}`.trim();
  const brave = await fetchPublic(`https://search.brave.com/search?${new URLSearchParams({ q: fallbackQuery, source: 'web' })}`, {
    headers: searchHeaders,
    timeoutMs: options.timeout ?? 15_000,
  });
  const braveResults = parseBrave(brave.body.toString('utf8'), options.limit ?? 5);
  if (braveResults.length) return braveResults;

  const bing = new URLSearchParams({ q: fallbackQuery, count: String(options.limit ?? 5) });
  const fallback = await fetchPublic(`https://www.bing.com/search?${bing}`, {
    headers: searchHeaders,
    timeoutMs: options.timeout ?? 15_000,
  });
  return parseBing(fallback.body.toString('utf8'), options.limit ?? 5);
}

interface TraverseOptions extends ScrapeOptions {
  limit?: number;
  maxDiscoveryDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
  allowExternalLinks?: boolean;
  allowSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  ignoreRobotsTxt?: boolean;
}

function matches(url: URL, options: TraverseOptions): boolean {
  const target = url.pathname + url.search;
  if (options.includePaths?.length && !options.includePaths.some((rule) => new RegExp(rule).test(target))) return false;
  return !options.excludePaths?.some((rule) => new RegExp(rule).test(target));
}

function normalizeLink(raw: string, base: URL, options: TraverseOptions): string | null {
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const sameHost = url.hostname === base.hostname;
    const subdomain = url.hostname.endsWith(`.${base.hostname}`) || base.hostname.endsWith(`.${url.hostname}`);
    if (!sameHost && !(options.allowSubdomains && subdomain) && !options.allowExternalLinks) return null;
    url.hash = '';
    if (options.ignoreQueryParameters) url.search = '';
    return matches(url, options) ? url.href : null;
  } catch {
    return null;
  }
}

async function robotsFor(base: URL): Promise<string> {
  try {
    return (await fetchPublic(new URL('/robots.txt', base).href, { maxBytes: 1024 * 1024 })).body.toString('utf8');
  } catch {
    return '';
  }
}

async function allowedByRobots(url: string, base: URL, robotsTxt: string, options: TraverseOptions): Promise<boolean> {
  if (options.ignoreRobotsTxt || !robotsTxt) return true;
  const verdict = (await firecrawlNative().filterUrl({
    href: url,
    url,
    baseUrl: base.href,
    excludes: [],
    ignoreRobotsTxt: false,
    robotsTxt,
    allowExternalContentLinks: options.allowExternalLinks ?? false,
    allowSubdomains: options.allowSubdomains ?? false,
  })) as { allowed?: boolean };
  return verdict.allowed !== false;
}

async function traverse(start: string, options: TraverseOptions, keepDocuments: boolean): Promise<{ links: string[]; documents: WebDocument[] }> {
  const base = new URL(start);
  const limit = Math.min(options.limit ?? (keepDocuments ? 10 : 100), keepDocuments ? 50 : 500);
  const maxDepth = Math.min(options.maxDiscoveryDepth ?? 3, 10);
  const robotsTxt = await robotsFor(base);
  const queue: Array<{ url: string; depth: number }> = [{ url: base.href, depth: 0 }];
  const seen = new Set<string>();
  const links: string[] = [];
  const documents: WebDocument[] = [];

  while (queue.length && seen.size < limit) {
    const item = queue.shift()!;
    if (seen.has(item.url) || !(await allowedByRobots(item.url, base, robotsTxt, options))) continue;
    seen.add(item.url);
    const document = await scrapeWeb(item.url, options);
    links.push(document.url);
    if (keepDocuments) documents.push(document);
    if (item.depth >= maxDepth) continue;
    for (const raw of document.links ?? []) {
      const url = normalizeLink(raw, base, options);
      if (url && !seen.has(url) && !queue.some((queued) => queued.url === url)) {
        queue.push({ url, depth: item.depth + 1 });
      }
    }
  }
  return { links, documents };
}

export async function mapWeb(url: string, options: TraverseOptions = {}): Promise<string[]> {
  return (await traverse(url, options, false)).links;
}

export async function crawlWeb(url: string, options: TraverseOptions = {}): Promise<WebDocument[]> {
  return (await traverse(url, options, true)).documents;
}
