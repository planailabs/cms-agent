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
import { validateBranchName } from '@/lib/git/engine';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const branch = url.searchParams.get('branch') ?? '';
  const route = url.searchParams.get('route');
  const kind = (url.searchParams.get('kind') ?? 'diff') as ShotKind;
  const a = asBrowser(url.searchParams.get('a'), 'chromium');
  const b = asBrowser(url.searchParams.get('b'), 'firefox');

  const invalid = validateBranchName(branch);
  if (invalid) return json({ error: invalid }, 400);
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
    return new Response(fs.readFileSync(result.files[kind]), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' },
    });
  } catch (err) {
    console.error('[browsers-diff] failed:', err);
    return json({ error: err instanceof Error ? err.message : 'Screenshot failed' }, 500);
  }
};
