/**
 * POST /api/chat/element-handoff — element-edit mode handoff.
 * Body: { chatId, note?, annotations } (annotations = EditAnnotations).
 *
 * Renders the annotated screenshot server-side (captureAnnotatedRoute replays
 * the annotation set on the branch preview), stores it as a chat-scoped
 * upload, throws the chat into the PLAN phase and starts the agent turn with
 * the screenshot + metadata message. 202; output arrives via SSE.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { annotationCount, type EditAnnotations } from '@/injected/annotate';
import { captureAnnotatedRoute } from '@/lib/diff/screenshot';
import { editAnnotationsSchema, handoffMessageText } from '@/lib/handoff/elementEdit';
import { handoffToPlan, WorkflowError } from '@/lib/agent/workflow';
import { ATTACHMENT_KINDS, storeUpload, UploadError } from '@/lib/uploads';

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
    select: { id: true, kind: true, archivedAt: true, workBranch: true, workflowPhase: true },
  });
  if (!chat) return json({ error: 'Chat not found' }, 404);
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
    const { buffer, status } = await captureAnnotatedRoute(
      chat.workBranch,
      annotations.route,
      annotations,
    );
    if (status !== null && status >= 400) {
      return json({ error: `The preview returned HTTP ${status} for ${annotations.route}.` }, 422);
    }

    const slug =
      annotations.route.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'home';
    const filename = `element-edit-${slug}.png`;
    const stored = storeUpload(filename, 'image/png', Buffer.from(buffer), ATTACHMENT_KINDS);
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        chatId: chat.id,
        filename,
        storedPath: stored.storedPath,
        mime: stored.mime,
        size: stored.size,
        sha256: stored.sha256,
      },
    });

    await handoffToPlan({
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
        uploadId: upload.id,
      }),
      attachmentIds: [upload.id],
    });
  } catch (err) {
    if (err instanceof WorkflowError) return json({ error: err.message }, err.status);
    if (err instanceof UploadError) return json({ error: err.message }, err.status);
    console.error('[element-handoff] failed:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }

  return json({ status: 'accepted' }, 202);
};
