/**
 * Fetch client for the booted bench server: dev-impersonation cookie jar plus
 * the SSE frame collector (lifted from test/integration/chat-loop.test.ts,
 * parameterized on base URL + cookies).
 */
import { benchRun } from './env';

export interface ApiResponse {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export class BenchClient {
  readonly baseUrl: string;
  private cookie = '';

  constructor(baseUrl = benchRun().baseUrl) {
    this.baseUrl = baseUrl;
  }

  /** Switch identity via POST /api/dev/impersonate (SKIP_AUTH dev users). */
  async as(email: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/dev/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify({ email }),
    });
    if (res.status !== 200) throw new Error(`impersonate ${email}: ${res.status}`);
    const setCookie = res.headers.getSetCookie();
    const dev = setCookie.find((c) => c.startsWith('cms_dev_user='));
    if (dev) this.cookie = dev.split(';')[0];
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    // Origin mirrors what a browser sends — Astro's checkOrigin rejects
    // form-content-type POSTs without it.
    return { origin: this.baseUrl, ...(this.cookie ? { cookie: this.cookie } : {}), ...extra };
  }

  async req(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  get(path: string): Promise<ApiResponse> {
    return this.req('GET', path);
  }

  async upload(filename: string, mime: string, data: Buffer, chatId?: string): Promise<ApiResponse> {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(data)], filename, { type: mime }));
    if (chatId) form.set('chatId', chatId);
    const res = await fetch(`${this.baseUrl}/api/uploads`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: JSON.parse(text), text };
  }

  /**
   * Subscribe to the chat SSE stream, run `send`, and collect events until one
   * of `doneEvents` (or the timeout) — the integration-test pattern.
   */
  async collectEvents(
    chatId: string,
    send: () => Promise<void>,
    doneEvents = ['done', 'question', 'error'],
    timeoutMs = 300_000,
  ): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    const controller = new AbortController();
    const res = await fetch(`${this.baseUrl}/api/chat/events?chatId=${chatId}`, {
      headers: this.headers(),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    await send();

    const deadline = Date.now() + timeoutMs;
    let buffer = '';
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventMatch = /^event: (.+)$/m.exec(chunk);
          const dataMatch = /^data: (.+)$/m.exec(chunk);
          if (!eventMatch) continue;
          events.push({
            event: eventMatch[1],
            data: dataMatch ? (JSON.parse(dataMatch[1]) as Record<string, unknown>) : {},
          });
          if (doneEvents.includes(eventMatch[1])) return events;
        }
      }
    } finally {
      controller.abort();
    }
    return events;
  }

  /** POST a chat message (expects 202) and collect the turn's SSE events. */
  async sendMessageAndCollect(
    chatId: string,
    text: string,
    opts: { type?: 'message' | 'answer'; timeoutMs?: number; attachmentIds?: string[] } = {},
  ): Promise<SseEvent[]> {
    return this.collectEvents(
      chatId,
      async () => {
        const res = await this.req('POST', '/api/chat/message', {
          chatId,
          type: opts.type ?? 'message',
          text,
          ...(opts.attachmentIds ? { attachmentIds: opts.attachmentIds } : {}),
        });
        if (res.status !== 202) {
          throw new Error(`send message: ${res.status} ${res.text.slice(0, 300)}`);
        }
      },
      undefined,
      opts.timeoutMs,
    );
  }
}

/** Concatenated assistant text of a collected turn. */
export const turnText = (events: SseEvent[]): string =>
  events
    .filter((e) => e.event === 'text_done')
    .map((e) => String(e.data.content ?? ''))
    .join('\n');
