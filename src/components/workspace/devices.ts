/**
 * Client side of the preview device presets — reads the curated list that
 * WorkspaceShell.astro inlines as JSON (source: playwright's device registry,
 * see src/lib/preview/devices.ts) and derives the `__cms_ua` query parameter
 * preview iframes carry so the proxy can override the upstream User-Agent.
 */

import type { PreviewDevice } from '@/lib/preview/devices';

export type { PreviewDevice };

/** Query param on preview-host URLs: sets (or, empty, clears) the per-branch
 *  User-Agent override in the proxy. Mirrored in proxy/src/lib.rs. */
export const UA_PARAM = '__cms_ua';

let cached: PreviewDevice[] | null = null;

export const previewDevices = (): PreviewDevice[] => {
  if (!cached) {
    try {
      cached = JSON.parse(
        document.getElementById('cms-preview-devices')?.textContent ?? '[]',
      ) as PreviewDevice[];
    } catch {
      cached = [];
    }
  }
  return cached;
};

export const deviceByKey = (key: string | null | undefined): PreviewDevice | null =>
  key ? (previewDevices().find((d) => d.key === key) ?? null) : null;

/** `__cms_ua=<encoded UA>` for a device, `__cms_ua=` (clear) for responsive. */
export const uaQueryParam = (device: PreviewDevice | null): string =>
  `${UA_PARAM}=${device ? encodeURIComponent(device.userAgent) : ''}`;

/** Append the UA param to a preview URL (route may already carry a query). */
export const withUaParam = (url: string, device: PreviewDevice | null): string =>
  `${url}${url.includes('?') ? '&' : '?'}${uaQueryParam(device)}`;
