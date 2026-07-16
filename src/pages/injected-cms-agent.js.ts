/**
 * GET /injected-cms-agent.js — the preview-page bootstrap engine, injected by
 * the proxy into every preview HTML response. An esbuild bundle of
 * src/injected/bootstrap.ts: prerendered (built once at `astro build`, served
 * as a static file), bundled per request in dev.
 */
import type { APIRoute } from 'astro';
import { bundleInjected } from '@/lib/injected/bundle';

export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(await bundleInjected('bootstrap'), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
