/**
 * GET /api/admin/usage?days=30 — token usage aggregated per user and per day
 * (dashboard charts).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/adminGuard';

export const GET: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const days = Math.min(Number(url.searchParams.get('days') ?? 30), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.tokenUsage.findMany({
    where: { createdAt: { gte: since } },
    include: { user: { select: { email: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const perUser = new Map<string, { email: string; name: string; input: number; output: number }>();
  const perDay = new Map<string, { input: number; output: number }>();
  for (const row of rows) {
    const u = perUser.get(row.userId) ?? {
      email: row.user.email,
      name: row.user.name,
      input: 0,
      output: 0,
    };
    u.input += row.inputTokens;
    u.output += row.outputTokens;
    perUser.set(row.userId, u);

    const day = row.createdAt.toISOString().slice(0, 10);
    const d = perDay.get(day) ?? { input: 0, output: 0 };
    d.input += row.inputTokens;
    d.output += row.outputTokens;
    perDay.set(day, d);
  }

  return new Response(
    JSON.stringify({
      days,
      perUser: [...perUser.entries()].map(([userId, v]) => ({ userId, ...v })),
      perDay: [...perDay.entries()].map(([day, v]) => ({ day, ...v })),
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
