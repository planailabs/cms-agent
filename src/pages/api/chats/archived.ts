/**
 * Archive view API. GET lists archived (done) chats across all branches;
 * DELETE ?id= permanently removes an archived chat with its work branch,
 * worktree, preview and data. Non-archived chats are refused.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { deleteChatDeep } from '@/lib/chatDelete';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async () => {
  const chats = await prisma.chat.findMany({
    where: { archivedAt: { not: null } },
    orderBy: { archivedAt: 'desc' },
    include: {
      branch: { select: { name: true } },
      createdBy: { select: { name: true } },
      publications: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { status: true, sha: true, externalUrl: true },
      },
    },
  });
  return json({
    chats: chats.map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind,
      branch: c.branch.name,
      workBranch: c.workBranch,
      createdBy: c.createdBy?.name ?? null,
      archivedAt: c.archivedAt,
      publication: c.publications[0] ?? null,
    })),
  });
};

export const DELETE: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  const chat = await prisma.chat.findUnique({ where: { id } });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  if (!chat.archivedAt) return json({ error: 'Only archived chats can be deleted here.' }, 400);

  await deleteChatDeep(chat);
  return json({ ok: true });
};
