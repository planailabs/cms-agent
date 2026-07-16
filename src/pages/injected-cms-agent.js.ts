/**
 * GET /injected-cms-agent.js — the preview-page bootstrap, injected by the
 * proxy into every preview HTML response. Built by Astro/Vite like any other
 * TS module: we serialize the compiled cmsAgentBootstrap function (it is
 * self-contained by contract) instead of maintaining a hand-written ES5 file.
 */
import type { APIRoute } from 'astro';
import { cmsAgentBootstrap } from '@/injected/bootstrap';

const source = `(${cmsAgentBootstrap.toString()})();\n`;

export const GET: APIRoute = () =>
  new Response(source, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
