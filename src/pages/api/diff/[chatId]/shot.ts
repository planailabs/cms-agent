/**
 * GET /api/diff/[chatId]/shot?route=/about/&kind=before|after|diff
 * Renders (or serves cached) screenshot-diff PNGs for a changed route.
 * ?meta=1 returns the diff metadata (changed pixel count) as JSON.
 */
export const prerender = false;

import fs from 'node:fs';
import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { diffRoute, type ShotKind } from '@/lib/diff/screenshot';

export const GET: APIRoute = async ({ params, url }) => {
  const route = url.searchParams.get('route');
  const kind = (url.searchParams.get('kind') ?? 'diff') as ShotKind;
  if (!route || !route.startsWith('/')) {
    return new Response(JSON.stringify({ error: 'route (starting with /) required' }), { status: 400 });
  }
  if (!['before', 'after', 'diff'].includes(kind)) {
    return new Response(JSON.stringify({ error: 'kind must be before|after|diff' }), { status: 400 });
  }

  const chat = await prisma.chat.findUnique({
    where: { id: params.chatId! },
    include: { branch: true },
  });
  if (!chat) return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });

  try {
    const result = await diffRoute(chat.workBranch, route, chat.branch.name);
    if (url.searchParams.get('meta')) {
      return new Response(
        JSON.stringify({
          route: result.route,
          changedPixels: result.changedPixels,
          totalPixels: result.totalPixels,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.searchParams.get('markers')) {
      const markersFile = `${result.files[kind]}.markers.json`;
      if (!fs.existsSync(markersFile)) {
        return new Response(JSON.stringify({ error: 'No markers for this shot' }), { status: 404 });
      }
      return new Response(fs.readFileSync(markersFile), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
      });
    }
    return new Response(fs.readFileSync(result.files[kind]), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' },
    });
  } catch (err) {
    console.error('[diff] screenshot failed:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Screenshot failed' }),
      { status: 500 },
    );
  }
};
