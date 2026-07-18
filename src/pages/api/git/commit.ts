/**
 * GET /api/git/commit?sha= — `git show` of one commit (message + stat +
 * patch) for the git modal's diff view. Read-only.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { showCommit } from '@/lib/git/engine';

const SHA = /^[0-9a-f]{7,40}$/;

export const GET: APIRoute = async ({ url }) => {
  const sha = url.searchParams.get('sha') ?? '';
  if (!SHA.test(sha)) {
    return new Response(JSON.stringify({ error: 'Invalid sha' }), { status: 400 });
  }
  try {
    const patch = await showCommit(sha);
    return new Response(JSON.stringify({ sha, patch }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Commit not found' }), { status: 404 });
  }
};
