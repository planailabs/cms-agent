import { createRequire } from 'node:module';

export interface FirecrawlNative {
  DocumentConverter: new () => {
    convertBufferToHtml(data: Buffer, documentType: number): string;
  };
  DocumentType: Record<'Doc' | 'Docx' | 'Rtf' | 'Odt' | 'Xlsx', number>;
  extractBaseHref(html: string, url: string): Promise<string>;
  extractLinks(html?: string): Promise<string[]>;
  extractMetadata(html?: string): Promise<Record<string, unknown>>;
  transformHtml(options: Record<string, unknown>): Promise<string>;
  getInnerJson(html: string): Promise<string>;
  extractAttributes(html: string, options: Record<string, unknown>): Promise<unknown[]>;
  extractImages(html: string, baseUrl: string): Promise<string[]>;
  postProcessMarkdown(markdown: string): Promise<string>;
  filterLinks(data: Record<string, unknown>): Promise<unknown>;
  filterUrl(data: Record<string, unknown>): Promise<unknown>;
  parseSitemapXml(xml: string): Promise<unknown>;
  processSitemap(xml: string): Promise<unknown>;
  computeEngpickerVerdict(
    results: Record<string, unknown>[],
    similarityThreshold: number,
    successRateThreshold: number,
    cdpFailureThreshold: number,
  ): Promise<unknown>;
  processPdf(path: string, maxPages?: number): Record<string, unknown>;
  detectPdf(path: string): Record<string, unknown>;
}

const state = globalThis as typeof globalThis & { __cmsFirecrawlNative?: FirecrawlNative };

export function firecrawlNative(): FirecrawlNative {
  if (state.__cmsFirecrawlNative) return state.__cmsFirecrawlNative;
  const addonPath = process.env.FIRECRAWL_NATIVE_PATH;
  if (!addonPath) throw new Error('FIRECRAWL_NATIVE_PATH is not configured');
  const loaded = createRequire(import.meta.url)(addonPath) as FirecrawlNative;
  state.__cmsFirecrawlNative = loaded;
  return loaded;
}

/** Test hook for the native boundary. */
export function setFirecrawlNativeForTest(binding?: FirecrawlNative): void {
  state.__cmsFirecrawlNative = binding;
}

export const FIRECRAWL_DOCUMENT_TYPES = {
  '.doc': 'Doc',
  '.docx': 'Docx',
  '.rtf': 'Rtf',
  '.odt': 'Odt',
  '.xlsx': 'Xlsx',
} as const;
