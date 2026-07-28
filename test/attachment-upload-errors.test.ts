/**
 * Upload error threading: the composer chip must surface the server's actual
 * reason — including non-JSON bodies like Astro's CSRF middleware text
 * ("Cross-site POST form submissions are forbidden") — not a bare generic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@/components/chat/app/store';
import {
  clearAttachments,
  getStagedAttachments,
  readyAttachmentIds,
  renderAttachmentChipsHtml,
  stageFiles,
} from '@/components/chat/actions/chat/attachments';

const stageOne = () => stageFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
const first = () => getStagedAttachments()[0];

beforeEach(() => {
  vi.stubGlobal('document', { querySelector: () => null, documentElement: { lang: 'en' } });
  store.state.activeChatId = 'chat';
  store.state.chat = { aiChat: true } as unknown as typeof store.state.chat;
});

afterEach(() => {
  clearAttachments();
  vi.unstubAllGlobals();
});

describe('composer attachment upload errors', () => {
  it('threads a non-JSON error body (CSRF 403) into a visible chip message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => 'Cross-site POST form submissions are forbidden',
      })),
    );
    stageOne();
    await vi.waitFor(() => expect(first().status).toBe('error'));
    expect(first().error).toContain('403');
    expect(first().error).toContain('Cross-site POST form submissions are forbidden');
    const html = renderAttachmentChipsHtml();
    expect(html).toContain('composer-chip__err');
    expect(html).toContain('Cross-site POST form submissions are forbidden');
  });

  it('keeps JSON error messages verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 415,
        text: async () => JSON.stringify({ error: 'File type not allowed' }),
      })),
    );
    stageOne();
    await vi.waitFor(() => expect(first().status).toBe('error'));
    expect(first().error).toBe('File type not allowed');
  });

  it('marks successful uploads ready without an error chip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ upload: { id: 'u1' } }),
      })),
    );
    stageOne();
    await vi.waitFor(() => expect(first().status).toBe('ready'));
    expect(readyAttachmentIds()).toEqual(['u1']);
    expect(renderAttachmentChipsHtml()).not.toContain('composer-chip__err');
  });

  it('falls back to a localized message on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    stageOne();
    await vi.waitFor(() => expect(first().status).toBe('error'));
    expect(first().error).toBe('Upload failed');
  });
});
