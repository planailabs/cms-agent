/**
 * POST /api/chats — create a chat on a branch (starts in the PLAN phase).
 * The client creates chats late (on the first message), so this is on the
 * user's critical path: adopt a pre-warmed work branch when one is ready and
 * get its preview server running before the browser asks for it.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { claimWorkBranch } from '@/lib/preview/prewarm';
import { defaultChatTitle } from '@/lib/chatTitle';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  let body: { branchId?: string; title?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.branchId) return json({ error: 'branchId required' }, 400);

  const branch = await prisma.branch.findUnique({ where: { id: body.branchId } });
  if (!branch) return json({ error: 'Branch not found' }, 404);

  const chat = await prisma.chat.create({
    data: {
      branchId: branch.id,
      // The chat's own work branch: worktree + preview subdomain, merged
      // into the target branch on publish. DNS-safe label.
      workBranch: await claimWorkBranch(branch.name),
      // In the creator's language: the title is STORED, so an English
      // placeholder is the one bit of chrome the language switch cannot fix.
      title: body.title?.trim() || defaultChatTitle(user.language ?? 'en'),
      createdById: user.id,
    },
  });

  // Index the branch into the codebase graph memory and get its preview
  // server up (fire-and-forget — both are ready before the user's first
  // turn finishes; a claimed spare is already running, so ensureInstance
  // returns immediately).
  void (async () => {
    const { ensureWorktree } = await import('@/lib/git/engine');
    const { indexChatWorktree } = await import('@/lib/agent/mcp/codebaseMemory');
    const { ensureInstance } = await import('@/lib/preview/manager');
    const worktree = await ensureWorktree(chat.workBranch, branch.name);
    void ensureInstance(chat.workBranch).catch((err) =>
      console.warn('[preview] chat-create warm-up failed:', err),
    );
    await indexChatWorktree(chat.id, worktree);
  })().catch((err) => console.warn('[codebase-memory] chat-create index failed:', err));

  return json({ chat }, 201);
};
