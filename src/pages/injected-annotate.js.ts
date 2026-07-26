/**
 * GET /injected-annotate.js — the annotation-replay bundle (globalName
 * __cmsAnnotate) used by captureAnnotatedRoute's Playwright page. Prerendered
 * at `astro build` so the PRODUCTION image (which ships no src/) has the
 * bundle as a static file in dist/client — annotateRuntimeSource() reads it
 * from there. Never fetched by browsers.
 */
import type { APIRoute } from 'astro';
import { bundleInjected } from '@/lib/injected/bundle';

export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(await bundleInjected('annotate'), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
