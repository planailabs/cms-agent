/**
 * GET /api/preview/browsers-shot?branch=&route=/&a=chromium&b=firefox&kind=before|after|diff
 * Cross-browser diff: renders the branch's route in two browser engines and
 * pixelmatches them. before = browser a, after = browser b. ?meta=1 returns
 * the changed-pixel metadata. Auth: any signed-in editor (middleware).
 */
export const prerender = false;

import fs from 'node:fs';
import type { APIRoute } from 'astro';
import { diffBrowsers, asBrowser, type ShotKind } from '@/lib/diff/screenshot';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// DNS-safe label — accepts existing preview branches incl. c-<id>/v-<sha>
// work/historical branches (validateBranchName rejects those as reserved,
// but here they're legitimate targets to screenshot).
const PREVIEW_BRANCH_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const branch = url.searchParams.get('branch') ?? '';
  const route = url.searchParams.get('route');
  const kind = (url.searchParams.get('kind') ?? 'diff') as ShotKind;
  const a = asBrowser(url.searchParams.get('a'), 'chromium');
  const b = asBrowser(url.searchParams.get('b'), 'firefox');

  if (!PREVIEW_BRANCH_RE.test(branch)) return json({ error: 'invalid branch' }, 400);
  if (!route || !route.startsWith('/')) return json({ error: 'route (starting with /) required' }, 400);
  if (!['before', 'after', 'diff'].includes(kind)) return json({ error: 'bad kind' }, 400);

  try {
    const result = await diffBrowsers(branch, route, a, b);
    if (url.searchParams.get('meta')) {
      return json({
        route: result.route,
        changedPixels: result.changedPixels,
        totalPixels: result.totalPixels,
      });
    }
    if (url.searchParams.get('markers')) {
      const markersFile = `${result.files[kind]}.markers.json`;
      if (!fs.existsSync(markersFile)) {
        return json({ error: 'No markers for this shot' }, 404);
      }
      return new Response(fs.readFileSync(markersFile), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
      });
    }
    return new Response(fs.readFileSync(result.files[kind]), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' },
    });
  } catch (err) {
    console.error('[browsers-diff] failed:', err);
    return json({ error: err instanceof Error ? err.message : 'Screenshot failed' }, 500);
  }
};
