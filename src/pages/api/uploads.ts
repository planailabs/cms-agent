/**
 * POST /api/uploads — multipart upload (field "file").
 * GET  /api/uploads?id=… — metadata; &mode=raw serves the bytes (chat-scoped,
 * which is what message image blocks render).
 */
export const prerender = false;

import fs from 'node:fs';
import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { chatAccessDenied } from '@/lib/chatAccess';
import { ATTACHMENT_KINDS, storeUpload, UploadError } from '@/lib/uploads';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data with a "file" field' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return json({ error: '"file" field required' }, 400);

  // Optional chat scoping applies the attachment type allow-list.
  const chatIdRaw = form.get('chatId');
  const chatId = typeof chatIdRaw === 'string' && chatIdRaw ? chatIdRaw : null;
  if (chatId) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, createdById: true },
    });
    if (!chat) return json({ error: 'Chat not found' }, 404);
    const denied = await chatAccessDenied(user, chat);
    if (denied) return denied;
  }

  try {
    const stored = storeUpload(
      file.name,
      file.type,
      Buffer.from(await file.arrayBuffer()),
      chatId ? ATTACHMENT_KINDS : undefined,
    );
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        chatId,
        filename: file.name,
        storedPath: stored.storedPath,
        mime: stored.mime,
        size: stored.size,
        sha256: stored.sha256,
      },
    });
    return json({ upload: { id: upload.id, filename: upload.filename, mime: upload.mime, size: upload.size } }, 201);
  } catch (err) {
    if (err instanceof UploadError) return json({ error: err.message }, err.status);
    throw err;
  }
};

export const GET: APIRoute = async ({ url, locals }) => {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  const raw = url.searchParams.get('mode') === 'raw';
  const upload = await prisma.upload.findUnique({
    where: { id },
    select: {
      id: true,
      filename: true,
      mime: true,
      size: true,
      sha256: true,
      createdAt: true,
      ...(raw ? { storedPath: true, chatId: true } : {}),
    },
  });
  if (!upload) return json({ error: 'Not found' }, 404);
  if (!raw) {
    const { storedPath: _p, chatId: _c, ...meta } = upload as typeof upload & {
      storedPath?: string;
      chatId?: string | null;
    };
    return json({ upload: meta });
  }

  // Bytes: this is what a message's image blocks point at (lib/messageBlocks),
  // so it is behind the same door as the chat that owns the upload. An upload
  // with no chat belongs to whoever is signed in — it never reached a
  // transcript to be shown in.
  const owned = upload as typeof upload & { storedPath: string; chatId: string | null };
  if (owned.chatId) {
    const chat = await prisma.chat.findUnique({
      where: { id: owned.chatId },
      select: { id: true, createdById: true, archivedAt: true },
    });
    if (!chat) return json({ error: 'Not found' }, 404);
    const denied = await chatAccessDenied(locals.user!, chat);
    if (denied) return denied;
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(owned.storedPath);
  } catch {
    return json({ error: 'The stored file is gone' }, 410);
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': upload.mime,
      'Content-Length': String(bytes.length),
      // Content-addressed by sha in the store: safe to keep, private to the
      // viewer who was allowed to fetch it.
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="${encodeURIComponent(upload.filename)}"`,
    },
  });
};
