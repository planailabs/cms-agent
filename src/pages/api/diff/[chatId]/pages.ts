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

  let workBranch = chat.workBranch;
  if (chat.kind === 'deployment') {
    const automatism = await prisma.automatism.findFirst({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'desc' },
      select: { data: true },
    });
    const source = (automatism?.data as { workBranch?: unknown } | null)?.workBranch;
    if (typeof source !== 'string' || !source) {
      return new Response(JSON.stringify({ error: 'Deployment source branch not found' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    workBranch = source;
  }

  const files = await changedFiles(workBranch, chat.branch.name);
  const plan = chat.planJson as { pages?: Array<{ url: string }> } | null;
  const plannedUrls = plan?.pages?.map((p) => p.url) ?? [];
  let inferredPages: Array<{ route: string; file: string }> = [];
  const graph = activeBackend().routeGraph;
  if (graph) {
    try {
      await Promise.all([ensureInstance(chat.branch.name), ensureInstance(workBranch)]);
      const [before, after] = await Promise.all([
        ensureWorktree(chat.branch.name),
        ensureWorktree(workBranch),
      ]);
      inferredPages = affectedGraphRoutes(files, [graph.read(before), graph.read(after)]);
    } catch (err) {
      console.warn('[diff] route dependency graph unavailable, using file and plan mappings:', err);
    }
  }
  const resolution = resolveChangedPages(files, plannedUrls, undefined, inferredPages);

  return new Response(
    JSON.stringify({
      branch: workBranch,
      targetBranch: chat.branch.name,
      changedFiles: files,
      // Part of every shot URL the client builds — see diffViewer.shotUrl.
      generation: compareGeneration(workBranch),
      ...resolution,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
