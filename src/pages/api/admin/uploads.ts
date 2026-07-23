/**
 * GET    /api/admin/uploads?sort=<field>&dir=<asc|desc> — list all uploads.
 * DELETE /api/admin/uploads?id=… — delete an upload (row + file on disk).
 */
export const prerender = false;

import fs from 'node:fs';
import type { APIRoute } from 'astro';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/adminGuard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** Whitelisted sort columns → Prisma orderBy (guards against injection). */
const orderByFor = (sort: string | null, dir: 'asc' | 'desc') => {
  switch (sort) {
    case 'filename':
      return { filename: dir };
    case 'mime':
      return { mime: dir };
    case 'size':
      return { size: dir };
    case 'user':
      return { user: { name: dir } };
    case 'createdAt':
    default:
      return { createdAt: dir };
  }
};

export const GET: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  const sort = url.searchParams.get('sort');
  const dir: 'asc' | 'desc' = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';

  const rows = await prisma.upload.findMany({
    orderBy: orderByFor(sort, dir),
    take: 500, // ponytail: cap the listing; paginate if this is ever exceeded
    select: {
      id: true,
      filename: true,
      mime: true,
      size: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
      chat: { select: { id: true, title: true } },
    },
  });

  const uploads = rows.map((u) => ({
    id: u.id,
    filename: u.filename,
    mime: u.mime,
    size: u.size,
    createdAt: u.createdAt,
    user: u.user ? u.user.name || u.user.email : null,
    chat: u.chat ? u.chat.title : null,
  }));
  return json({ uploads, sort: sort ?? 'createdAt', dir });
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const upload = await prisma.upload.findUnique({ where: { id }, select: { storedPath: true } });
  if (!upload) return json({ error: 'Not found' }, 404);

  await prisma.upload.delete({ where: { id } });
  // Best-effort file removal — the row is the source of truth.
  try {
    fs.rmSync(upload.storedPath, { force: true });
  } catch {
    // already gone / unreadable — ignore
  }
  return json({ ok: true });
};
