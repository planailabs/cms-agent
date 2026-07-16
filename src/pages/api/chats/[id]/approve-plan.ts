export const prerender = false;

import type { APIRoute } from 'astro';
import { approvePlan, WorkflowError } from '@/lib/agent/workflow';

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  let body: { expectedVersion?: number; idempotencyKey?: string } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }
  try {
    await approvePlan({
      chatId: params.id!,
      actor: user,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
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
