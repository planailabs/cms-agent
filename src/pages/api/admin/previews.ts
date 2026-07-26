/**
 * Admin preview instance management. GET lists running instances and failed
 * starts; POST { branch, action: stop | restart | repair } — restart/repair
 * are fire-and-forget (poll GET for the outcome), repair re-installs deps.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { z } from 'zod';
import {
  clearStartError,
  ensureInstance,
  listInstances,
  listStartErrors,
  stopInstance,
} from '@/lib/preview/manager';
import { isBranchShaped } from '@/lib/git/engine';
import { requireAdmin } from '@/lib/adminGuard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  return json({ instances: listInstances(), errors: listStartErrors() });
};

const actionSchema = z.object({
  branch: z.string().min(1),
  action: z.enum(['stop', 'restart', 'repair']),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) return json({ error: parsed.error.message }, 400);
  const { branch, action } = parsed.data;
  // Shape check only — creation rules would reject 'main' and the c-/v-
  // system instances, which are exactly what admins manage here.
  if (!isBranchShaped(branch)) return json({ error: 'Invalid branch name' }, 400);

  await stopInstance(branch);
  clearStartError(branch);
  if (action !== 'stop') {
    void ensureInstance(branch, action === 'repair').catch((err) =>
      console.error(`[admin] ${action} of preview ${branch} failed:`, err),
    );
  }
  return json({ ok: true }, 202);
};
