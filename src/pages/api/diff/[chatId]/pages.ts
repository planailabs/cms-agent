/**
 * GET /api/diff/[chatId]/pages — changed routes of the chat's branch
 * (git diff + the backend's dependency graph, when it has one, + the
 * approved plan's page list).
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';
import { changedFiles, ensureWorktree } from '@/lib/git/engine';
import { resolveChangedPages } from '@/lib/diff/routes';
import { ensureInstance } from '@/lib/preview/manager';
import { affectedGraphRoutes } from '@/lib/preview/routeGraph';
import { activeBackend } from '@/lib/site';
import { compareGeneration } from '@/lib/diff/screenshot';

export const GET: APIRoute = async ({ params, locals }) => {
  const chat = await prisma.chat.findUnique({
    where: { id: params.chatId! },
    include: { branch: true },
  });
  if (!chat) return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  const denied = await chatAccessDenied(locals.user!, chat);
  if (denied) return denied;

  const files = await changedFiles(chat.workBranch, chat.branch.name);
  const plan = chat.planJson as { pages?: Array<{ url: string }> } | null;
  const plannedUrls = plan?.pages?.map((p) => p.url) ?? [];
  let inferredPages: Array<{ route: string; file: string }> = [];
  const graph = activeBackend().routeGraph;
  if (graph) {
    try {
      await Promise.all([ensureInstance(chat.branch.name), ensureInstance(chat.workBranch)]);
      const [before, after] = await Promise.all([
        ensureWorktree(chat.branch.name),
        ensureWorktree(chat.workBranch),
      ]);
      inferredPages = affectedGraphRoutes(files, [graph.read(before), graph.read(after)]);
    } catch (err) {
      console.warn('[diff] route dependency graph unavailable, using file and plan mappings:', err);
    }
  }
  const resolution = resolveChangedPages(files, plannedUrls, undefined, inferredPages);

  return new Response(
    JSON.stringify({
      branch: chat.workBranch,
      targetBranch: chat.branch.name,
      changedFiles: files,
      // Part of every shot URL the client builds — see diffViewer.shotUrl.
      generation: compareGeneration(chat.workBranch),
      ...resolution,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
