/**
 * Preview device presets — a curated slice of Playwright's device registry
 * (the maintained source of viewport + UA + scale-factor descriptors, already
 * a dependency for screenshots). Served to the workspace client inline by
 * WorkspaceShell.astro and used server-side to drive real device emulation
 * in the browser-compare screenshot pipeline.
 *
 * Playwright is imported dynamically like every other server call site — the
 * package must stay external to the Vite SSR bundle.
 */

export interface PreviewDevice {
  /** Playwright registry key — also the value the client round-trips. */
  key: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent: string;
}

// ponytail: fixed curated list — expose more registry keys here when asked.
const CURATED = [
  'iPhone 15',
  'iPhone 15 landscape',
  'Pixel 7',
  'Pixel 7 landscape',
  'Galaxy S9+',
  'iPad Mini',
  'iPad Mini landscape',
  'iPad Pro 11',
  'iPad Pro 11 landscape',
  'Desktop Chrome',
  'Desktop Firefox',
  'Desktop Safari',
] as const;

let cached: PreviewDevice[] | null = null;

export async function previewDeviceList(): Promise<PreviewDevice[]> {
  if (cached) return cached;
  const { devices } = await import('playwright');
  cached = CURATED.map((key) => {
    const d = devices[key];
    if (!d) throw new Error(`preview device missing from playwright registry: ${key}`);
    return {
      key,
      width: d.viewport.width,
      height: d.viewport.height,
      deviceScaleFactor: d.deviceScaleFactor,
      isMobile: d.isMobile,
      hasTouch: d.hasTouch,
      userAgent: d.userAgent,
    };
  });
  return cached;
}

/** Descriptor for a preset key, or null (unknown / empty). */
export async function getPreviewDevice(key: string | null | undefined): Promise<PreviewDevice | null> {
  if (!key) return null;
  return (await previewDeviceList()).find((d) => d.key === key) ?? null;
}
