/**
 * GET /injected-agent-module.js — the initial injected-agent module as a
 * parenthesized function expression: exactly the payload the bootstrap's
 * cms:load-module expects. The workspace fetches this URL (same-origin,
 * authenticated) and submits the text into the preview iframe.
 *
 * Built by Astro/Vite like any other TS module; cmsAgentModule is
 * self-contained by contract so its compiled source is the whole file.
 */
import type { APIRoute } from 'astro';
import { cmsAgentModule } from '@/injected/agentModule';

const source = `(${cmsAgentModule.toString()})\n`;

export const GET: APIRoute = () =>
  new Response(source, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
