/**
 * POST /api/chats/:id/sync — Sync button: starts the 'pull' automatism that
 * rebases the chat's work branch onto the latest target branch. Conflicts
 * pause the automatism and invoke the agent in this chat.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { WorkflowError } from '@/lib/agent/workflow';
import { TurnInProgressError } from '@/lib/automatism';
import { startPull } from '@/lib/publish/publisher';

export const POST: APIRoute = async ({ params, locals }) => {
  const user = locals.user!;
  try {
    const automatismId = await startPull(params.id!, user);
    return new Response(JSON.stringify({ ok: true, automatismId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // A turn that started between the guard and the spawn lands here.
    if (err instanceof TurnInProgressError) {
      return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    }
    if (err instanceof WorkflowError) {
      return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    }
    throw err;
  }
};
