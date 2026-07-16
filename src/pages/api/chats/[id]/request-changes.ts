export const prerender = false;

import type { APIRoute } from 'astro';
import { requestChanges, WorkflowError } from '@/lib/agent/workflow';

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  let body: { feedback?: string; expectedVersion?: number };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  if (!body.feedback?.trim()) {
    return new Response(JSON.stringify({ error: 'feedback required' }), { status: 400 });
  }
  try {
    await requestChanges({
      chatId: params.id!,
      actor: user,
      feedback: body.feedback.trim(),
      expectedVersion: body.expectedVersion,
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof WorkflowError) {
      return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    }
    throw err;
  }
};
