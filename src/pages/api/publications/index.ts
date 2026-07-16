/**
 * GET /api/publications — persisted deployment state (list).
 * GET /api/publications?id=… — one publication with its full log + artifacts.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('id');

  if (id) {
    const p = await prisma.publication.findUnique({
      where: { id },
      include: {
        branch: { select: { name: true } },
        chat: { select: { id: true, title: true } },
        artifacts: true,
      },
    });
    if (!p) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify({ publication: p }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const publications = await prisma.publication.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      flow: true,
      sha: true,
      externalUrl: true,
      createdAt: true,
      branch: { select: { name: true } },
      chat: { select: { id: true, title: true } },
    },
  });
  return new Response(JSON.stringify({ publications }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
