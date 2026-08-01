/**
 * Upload pipeline (plan §12 / medved §19.1): auth, size limit, extension +
 * MIME + magic-byte checks, random internal names, storage under
 * VAR_DIR/uploads (outside any webroot). Upload content is always untrusted
 * DATA — never instructions, never mounted into the worktree directly.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Coarse category of an upload. */
export type UploadKind = 'text' | 'document' | 'pdf' | 'image';

interface TypeRule {
  kind: UploadKind;
  ext: string[];
  mime: string[];
  /** Returns true when the file's leading bytes match the declared type. */
  magic: (buf: Buffer) => boolean;
}

const isText = (buf: Buffer) => !buf.subarray(0, 4096).includes(0);
const isZip = (buf: Buffer) =>
  buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
  buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const isZipWith = (marker: string) => (buf: Buffer) =>
  isZip(buf) && buf.includes(Buffer.from(marker));
const isOle = (buf: Buffer) =>
  buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

const TYPE_RULES: TypeRule[] = [
  { kind: 'text', ext: ['.md', '.markdown', '.txt'], mime: ['text/markdown', 'text/plain'], magic: isText },
  { kind: 'pdf', ext: ['.pdf'], mime: ['application/pdf'], magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { kind: 'document', ext: ['.doc'], mime: ['application/msword', 'application/vnd.ms-word'], magic: isOle },
  { kind: 'document', ext: ['.docx'], mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], magic: isZipWith('word/') },
  { kind: 'document', ext: ['.rtf'], mime: ['application/rtf', 'text/rtf'], magic: (b) => b.subarray(0, 5).toString('latin1') === '{\\rtf' },
  { kind: 'document', ext: ['.odt'], mime: ['application/vnd.oasis.opendocument.text'], magic: isZipWith('application/vnd.oasis.opendocument.text') },
  { kind: 'document', ext: ['.xlsx'], mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], magic: isZipWith('xl/') },
  { kind: 'image', ext: ['.png'], mime: ['image/png'], magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: 'image', ext: ['.jpg', '.jpeg'], mime: ['image/jpeg'], magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', ext: ['.webp'], mime: ['image/webp'], magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { kind: 'image', ext: ['.gif'], mime: ['image/gif'], magic: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
];

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** All safely validated types can be attached to chat. `accept` for <input>/DnD. */
export const ATTACHMENT_KINDS: UploadKind[] = ['text', 'document', 'pdf', 'image'];
export const ATTACHMENT_ACCEPT = TYPE_RULES.filter((r) => ATTACHMENT_KINDS.includes(r.kind))
  .flatMap((r) => [...r.ext, ...r.mime])
  .join(',');

export interface StoredUpload {
  storedPath: string;
  sha256: string;
  size: number;
  mime: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function uploadsDir(): string {
  return path.join(path.resolve(env().VAR_DIR), 'uploads');
}

/**
 * Validate and store an upload; throws UploadError on any check failure.
 * `allow` restricts the accepted categories (chat attachments pass
 * categories); omitted means all supported types.
 */
export function storeUpload(
  filename: string,
  declaredMime: string,
  data: Buffer,
  allow?: UploadKind[],
): StoredUpload {
  if (data.length === 0) throw new UploadError('Empty file');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(`File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`, 413);
  }

  const ext = path.extname(filename).toLowerCase();
  const allowed = allow ? TYPE_RULES.filter((r) => allow.includes(r.kind)) : TYPE_RULES;
  const rule = allowed.find((r) => r.ext.includes(ext));
  if (!rule) {
    const kinds = (allow ?? ['text', 'document', 'pdf', 'image']).join(', ');
    throw new UploadError(`File type not allowed: ${ext || '(none)'} — allowed categories: ${kinds}`);
  }
  if (declaredMime && !rule.mime.includes(declaredMime.split(';')[0].trim())) {
    throw new UploadError(`MIME type ${declaredMime} does not match extension ${ext}`);
  }
  if (!rule.magic(data)) {
    throw new UploadError(`File content does not match its declared type (${ext})`);
  }

  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, `${randomUUID()}${ext}`);
  fs.writeFileSync(storedPath, data);

  return {
    storedPath,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
    mime: rule.mime[0],
  };
}
