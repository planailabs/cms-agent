export const prerender = false;

import type { APIRoute } from 'astro';
import { finalizeExecution, WorkflowError } from '@/lib/agent/workflow';

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  let body: { summary?: string; expectedVersion?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }
  try {
    const { sha } = await finalizeExecution({
      chatId: params.id!,
      actor: user,
      summary: body.summary,
      expectedVersion: body.expectedVersion,
    });
    return new Response(JSON.stringify({ ok: true, sha }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof WorkflowError) {
      return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    }
    throw err;
  }
};
