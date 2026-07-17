/**
 * Admin chat management. GET lists all chats (any user); DELETE ?id=
 * removes a chat and its work branch (preview, worktree, git ref).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { deleteBranch, removeWorktree } from '@/lib/git/engine';
import { stopInstance, clearStartError } from '@/lib/preview/manager';
import { removeScratchpad } from '@/lib/agent/tools/scratchTools';
import { requireAdmin } from '@/lib/adminGuard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const chats = await prisma.chat.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { email: true } },
      branch: { select: { name: true } },
      _count: { select: { messages: true } },
    },
  });
  return json({
    chats: chats.map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind,
      workflowPhase: c.workflowPhase,
      branch: c.branch.name,
      workBranch: c.workBranch,
      createdBy: c.createdBy?.email ?? null,
      messages: c._count.messages,
      createdAt: c.createdAt,
    })),
  });
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  const chat = await prisma.chat.findUnique({ where: { id } });
  if (!chat) return json({ error: 'Chat not found' }, 404);

  await stopInstance(chat.workBranch);
  clearStartError(chat.workBranch);
  await removeWorktree(chat.workBranch);
  await deleteBranch(chat.workBranch);
  removeScratchpad(chat.id);
  await prisma.chat.delete({ where: { id } });
  return json({ ok: true });
};
