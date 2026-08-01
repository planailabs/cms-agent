/**
 * POST /api/chat/element-handoff — element-edit mode handoff.
 * Body: { chatId, note?, annotations } (annotations = EditAnnotations).
 *
 * Renders THREE screenshots server-side off one page load (captureAnnotatedRoute
 * replays the annotation set on the branch preview): the page as it is, the
 * page with the requested moves/swaps carried out and nothing drawn on it, and
 * the page with the user's marks. Each is stored as a chat-scoped upload; the
 * chat goes into the PLAN phase and the agent turn starts with the metadata
 * message pointing at all three. 202; output arrives via SSE.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';
import { annotationCount, type EditAnnotations } from '@/injected/annotate';
import type { DisplayBlock } from '@/lib/messageBlocks';
import { captureElementEditUploads, editAnnotationsSchema, handoffMessageText } from '@/lib/handoff/elementEdit';
import { handoffToPlan, WorkflowError } from '@/lib/agent/workflow';
import { UploadError } from '@/lib/uploads';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const bodySchema = z.object({
  chatId: z.string().min(1),
  note: z.string().max(4000).default(''),
  annotations: editAnnotationsSchema,
});

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: `Invalid body: ${parsed.error.issues[0]?.message ?? 'malformed'}` }, 400);
  }
  const { chatId, note } = parsed.data;
  const annotations = parsed.data.annotations as EditAnnotations;
  if (annotationCount(annotations) === 0) {
    return json({ error: 'The annotation set is empty — nothing to hand off.' }, 400);
  }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { id: true, kind: true, archivedAt: true, workBranch: true, workflowPhase: true, createdById: true },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
  const denied = await chatAccessDenied(user, chat);
  if (denied) return denied;
  if (chat.archivedAt) {
    return json({ error: 'This chat is archived and no longer accepts messages.' }, 409);
  }
  if ((chat.kind ?? 'workflow') !== 'workflow') {
    return json({ error: 'Element-edit handoff is only available on workflow chats.' }, 409);
  }
  if (chat.workflowPhase === 'published') {
    return json({ error: 'Cannot hand off to planning from the published phase.' }, 409);
  }

  try {
    const uploads = await captureElementEditUploads({
      chatId: chat.id,
      userId: user.id,
      workBranch: chat.workBranch,
      annotations,
    });
    const { before, edited, annotated } = uploads;

    // The transcript shows the handoff as a card — the page it is about, what
    // was drawn, and the shots themselves (lib/messageBlocks). The agent still
    // reads the text above; blocks are for the person scrolling back.
    const blocks: DisplayBlock[] = [
      {
        kind: 'handoff',
        route: annotations.route,
        ...(note ? { note } : {}),
        shots: [
          { uploadId: before, label: 'before' },
          ...(edited ? [{ uploadId: edited, label: 'requested' }] : []),
          { uploadId: annotated, label: 'annotated' },
        ],
        counts: {
          moves: annotations.moves.length,
          swaps: annotations.swaps?.length ?? 0,
          strokes: annotations.strokes.length,
          comments: annotations.comments.length,
        },
      },
    ];

    await handoffToPlan({
      blocks,
      chatId: chat.id,
      actor: {
        id: user.id,
        name: user.name ?? '',
        email: user.email ?? '',
        language: user.language ?? undefined,
      },
      text: handoffMessageText({
        actorName: user.name ?? 'the user',
        note,
        annotations,
        uploads,
      }),
      attachmentIds: [before, ...(edited ? [edited] : []), annotated],
    });
  } catch (err) {
    if (err instanceof WorkflowError) return json({ error: err.message }, err.status);
    if (err instanceof UploadError) return json({ error: err.message }, err.status);
    console.error('[element-handoff] failed:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }

  return json({ status: 'accepted' }, 202);
};
