/**
 * GET /api/diff/[chatId]/pages — changed routes of the chat's branch
 * (git diff against main + the approved plan's page list).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { changedFiles } from '@/lib/git/engine';
import { resolveChangedPages } from '@/lib/diff/routes';

export const GET: APIRoute = async ({ params }) => {
  const chat = await prisma.chat.findUnique({
    where: { id: params.chatId! },
    include: { branch: true },
  });
  if (!chat) return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });

  const files = await changedFiles(chat.workBranch, chat.branch.name);
  const plan = chat.planJson as { pages?: Array<{ url: string }> } | null;
  const plannedUrls = plan?.pages?.map((p) => p.url) ?? [];
  const resolution = resolveChangedPages(files, plannedUrls);

  return new Response(
    JSON.stringify({
      branch: chat.workBranch,
      targetBranch: chat.branch.name,
      changedFiles: files,
      ...resolution,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
