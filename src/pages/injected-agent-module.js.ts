/**
 * GET /injected-agent-module.js — the initial injected-agent module: an
 * esbuild IIFE bundle (globalName __cmsAgentModule) of
 * src/injected/module/index.ts, exactly the payload the engine's
 * cms:load-module expects. The workspace fetches this URL (same-origin,
 * authenticated) and submits the text into the preview iframe. Prerendered at
 * `astro build`; bundled per request in dev.
 */
import type { APIRoute } from 'astro';
import { bundleInjected } from '@/lib/injected/bundle';

export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(await bundleInjected('module'), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
