export const prerender = false;

import type { APIRoute } from 'astro';
import { WorkflowError } from '@/lib/agent/workflow';
import { publish } from '@/lib/publish/publisher';

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  let body: { sha?: string; expectedVersion?: number; idempotencyKey?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  if (!body.sha) {
    return new Response(JSON.stringify({ error: 'sha required (exact reviewed branch head)' }), {
      status: 400,
    });
  }
  try {
    const { publicationId, deployChatId } = await publish({
      chatId: params.id!,
      sha: body.sha,
      actor: user,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
    });
    return new Response(JSON.stringify({ ok: true, publicationId, deployChatId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof WorkflowError) {
      return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    }
    throw err;
  }
};
