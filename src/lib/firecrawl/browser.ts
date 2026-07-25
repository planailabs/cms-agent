import { assertPublicUrl } from './fetch';

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
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  try {
    const checkedHosts = new Set<string>();
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (/^(data|blob|about):/.test(url)) return route.continue();
      try {
        const parsed = new URL(url);
        if (!checkedHosts.has(parsed.host)) {
          await assertPublicUrl(url);
          checkedHosts.add(parsed.host);
        }
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
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
