import { assertPublicUrl } from './fetch';
import { fetchPublic } from './fetch';

type Browser = import('playwright').Browser;

const state = globalThis as typeof globalThis & {
  __cmsWebBrowser?: Promise<Browser>;
  __cmsWebBrowserSlots?: number;
  __cmsWebBrowserWaiters?: Array<() => void>;
};

const MAX_PAGES = 4;

async function browser(): Promise<Browser> {
  state.__cmsWebBrowser ??= import('playwright').then(({ chromium }) =>
    chromium.launch({ chromiumSandbox: false }),
  );
  try {
    return await state.__cmsWebBrowser;
  } catch (error) {
    delete state.__cmsWebBrowser;
    throw error;
  }
}

async function acquire(): Promise<void> {
  state.__cmsWebBrowserSlots ??= 0;
  state.__cmsWebBrowserWaiters ??= [];
  if (state.__cmsWebBrowserSlots < MAX_PAGES) {
    state.__cmsWebBrowserSlots++;
    return;
  }
  await new Promise<void>((resolve) => state.__cmsWebBrowserWaiters!.push(resolve));
}

function release(): void {
  const next = state.__cmsWebBrowserWaiters?.shift();
  if (next) next();
  else state.__cmsWebBrowserSlots = Math.max(0, (state.__cmsWebBrowserSlots ?? 1) - 1);
}

export interface BrowserScrapeOptions {
  headers?: Record<string, string>;
  mobile?: boolean;
  waitFor?: number;
  timeout?: number;
  userAgent?: string;
}

export interface BrowserScrapeResult {
  html: string;
  status: number;
  title: string;
  url: string;
}

export async function scrapeInBrowser(
  value: string,
  options: BrowserScrapeOptions = {},
): Promise<BrowserScrapeResult> {
  const initial = await assertPublicUrl(value);
  await acquire();
  const context = await (await browser()).newContext({
    extraHTTPHeaders: options.headers,
    isMobile: options.mobile,
    userAgent: options.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    serviceWorkers: 'block',
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (/^(data|blob|about):/.test(url)) return route.continue();
      try {
        const request = route.request();
        const fetched = await fetchPublic(url, {
          method: request.method(),
          headers: await request.allHeaders(),
          body: request.postDataBuffer() ?? undefined,
          timeoutMs: options.timeout,
        });
        await route.fulfill({ status: fetched.status, headers: fetched.headers, body: fetched.body });
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await context.newPage();
    const response = await page.goto(initial.href, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout ?? 30_000,
    });
    if (options.waitFor) await page.waitForTimeout(options.waitFor);
    else await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    return {
      html: await page.content(),
      status: response?.status() ?? 0,
      title: await page.title(),
      url: page.url(),
    };
  } finally {
    await context.close();
    release();
  }
}
