/**
 * POST /api/uploads — multipart upload (field "file").
 * GET  /api/uploads?id=… — metadata.
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
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
    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) return json({ error: 'Chat not found' }, 404);
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

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  const upload = await prisma.upload.findUnique({
    where: { id },
    select: { id: true, filename: true, mime: true, size: true, sha256: true, createdAt: true },
  });
  if (!upload) return json({ error: 'Not found' }, 404);
  return json({ upload });
};
