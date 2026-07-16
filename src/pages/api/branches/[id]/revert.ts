export const prerender = false;

import type { APIRoute } from 'astro';
import { revertExecution, WorkflowError } from '@/lib/agent/workflow';

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  let body: { sha?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  if (!body.sha) {
    return new Response(JSON.stringify({ error: 'sha required' }), { status: 400 });
  }
  try {
    const revertSha = await revertExecution({
      branchId: params.id!,
      sha: body.sha,
      actor: user,
    });
    return new Response(JSON.stringify({ ok: true, revertSha }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof WorkflowError) {
      return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    }
    throw err;
  }
};
