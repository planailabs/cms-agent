/**
 * Composer attachments — client-side staging of files before they're sent with
 * a chat message. Files upload to /api/uploads (chat-scoped) immediately on
 * stage; their ids ride along with the next message. The server re-validates
 * type/size/ownership — this is convenience only.
 *
 * State is held in this module (not the store) and the chips are updated
 * imperatively: a full store.notify() re-renders the chat section from an HTML
 * string, which would wipe text the user is mid-typing in the composer.
 */

import { store } from '../../app/store';
import { escapeHtml } from '../../utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AttachmentDisplay } from './cache';
import { materializeDraftChat } from './stateMachine';

// ponytail: mirrors the server allow-list in src/lib/uploads.ts;
// the server is the gate, this only filters the file picker / drop.
export const ATTACHMENT_ACCEPT =
  '.txt,.md,.markdown,.pdf,.doc,.docx,.rtf,.odt,.xlsx,.png,.jpg,.jpeg,.webp,.gif,' +
  'text/plain,text/markdown,application/pdf,application/msword,application/rtf,text/rtf,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.oasis.opendocument.text,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'image/png,image/jpeg,image/webp,image/gif';

const ALLOWED_EXT = /\.(txt|md|markdown|pdf|docx?|rtf|odt|xlsx|png|jpe?g|webp|gif)$/i;

export interface StagedAttachment {
  localId: string;
  filename: string;
  mime: string;
  size: number;
  /** Object URL for image preview (revoked on remove). */
  url?: string;
  /** Set once uploaded. */
  uploadId?: string;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
}

let items: StagedAttachment[] = [];
let seq = 0;

export const getStagedAttachments = (): readonly StagedAttachment[] => items;

/** Ready (uploaded) attachment ids, in stage order. */
export const readyAttachmentIds = (): string[] =>
  items.filter((a) => a.status === 'ready' && a.uploadId).map((a) => a.uploadId!);

/** Ready attachments as display metadata for the sent user bubble. */
export const readyAttachmentMeta = (): AttachmentDisplay[] =>
  items
    .filter((a) => a.status === 'ready' && a.uploadId)
    .map((a) => ({ id: a.uploadId, filename: a.filename, mime: a.mime }));

const hasReady = (): boolean => items.some((a) => a.status === 'ready');

export const clearAttachments = (): void => {
  for (const a of items) if (a.url) URL.revokeObjectURL(a.url);
  items = [];
  syncChips();
};

export const removeAttachment = (localId: string): void => {
  const idx = items.findIndex((a) => a.localId === localId);
  if (idx < 0) return;
  const [removed] = items.splice(idx, 1);
  if (removed.url) URL.revokeObjectURL(removed.url);
  syncChips();
};

const isAllowed = (file: File): boolean =>
  ALLOWED_EXT.test(file.name) || file.type.startsWith('image/') || file.type.startsWith('text/');

/**
 * Stage and upload files. Enforces the one-per-message cap when the admin
 * setting is on (server re-checks). Draft chats are materialized first;
 * uploads then continue in the background.
 */
export const stageFiles = async (files: Iterable<File>): Promise<void> => {
  if (!store.state.chat?.aiChat) return;
  if (!store.state.activeChatId && !(await materializeDraftChat())) return;
  const chatId = store.state.activeChatId!;
  const onePerMessage = store.state.attachmentsOnePerMessage;

  for (const file of files) {
    if (onePerMessage && items.length >= 1) break;
    if (!isAllowed(file)) continue;

    const localId = `att-${++seq}`;
    items.push({
      localId,
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      status: 'uploading',
    });
    void uploadOne(file, localId, chatId);
    if (onePerMessage) break;
  }
  syncChips();
};

async function uploadOne(file: File, localId: string, chatId: string): Promise<void> {
  const find = () => items.find((a) => a.localId === localId);
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('chatId', chatId);
    const res = await fetch('/api/uploads', { method: 'POST', body: form });
    // Non-JSON bodies (e.g. Astro's CSRF middleware answers text/plain) still
    // carry the reason — surface them instead of a generic failure.
    const body = await res.text();
    let data: { upload?: { id: string }; error?: string } = {};
    try {
      data = JSON.parse(body) as typeof data;
    } catch {
      /* non-JSON body — kept in `body` */
    }
    const item = find();
    if (!item) return; // removed while uploading
    if (res.ok && data.upload) {
      item.uploadId = data.upload.id;
      item.status = 'ready';
    } else {
      item.status = 'error';
      item.error =
        data.error ??
        (body.trim()
          ? `${t(uiLocale(), 'chat.attach.failed')} (${res.status}): ${body.trim().slice(0, 200)}`
          : `${t(uiLocale(), 'chat.attach.failed')} (${res.status})`);
    }
  } catch {
    const item = find();
    if (item) {
      item.status = 'error';
      item.error = t(uiLocale(), 'chat.attach.failed');
    }
  }
  syncChips();
}

// ─── Imperative chip rendering ────────────────────────────────────────────────

/** HTML for the chips row — used both on full render and imperative sync. */
export const renderAttachmentChipsHtml = (): string =>
  items
    .map((a) => {
      const thumb = a.url
        ? `<img class="composer-chip__thumb" src="${escapeHtml(a.url)}" alt="" />`
        : `<span class="composer-chip__glyph" aria-hidden="true">📄</span>`;
      const state =
        a.status === 'uploading' ? ' is-uploading' : a.status === 'error' ? ' is-error' : '';
      return `<span class="composer-chip${state}" title="${escapeHtml(a.error ?? a.filename)}">
          ${thumb}
          <span class="composer-chip__name">${escapeHtml(a.filename)}</span>
          ${a.status === 'error' ? `<span class="composer-chip__err">${escapeHtml(a.error ?? t(uiLocale(), 'chat.attach.failed'))}</span>` : ''}
          <button type="button" class="composer-chip__remove" data-action="chat-attach-remove"
            data-local-id="${escapeHtml(a.localId)}"
            aria-label="${escapeHtml(t(uiLocale(), 'chat.attach.remove'))}">×</button>
        </span>`;
    })
    .join('');

/** Whether the send button should be enabled given text + ready attachments. */
export const composerHasContent = (inputText: string): boolean =>
  inputText.trim().length > 0 || hasReady();

/** Refresh the chips container and send-button state in place. */
export const syncChips = (): void => {
  const box = document.querySelector<HTMLElement>('[data-attach-chips]');
  if (box) box.innerHTML = renderAttachmentChipsHtml();
  const input = document.querySelector<HTMLElement>('[data-action="machine-config-input"]');
  const btn = document.querySelector<HTMLButtonElement>('[data-action="machine-config-send"]');
  if (btn) {
    const enabled = composerHasContent(input?.textContent ?? '');
    btn.disabled = !enabled;
    btn.setAttribute('aria-disabled', String(!enabled));
  }
};
