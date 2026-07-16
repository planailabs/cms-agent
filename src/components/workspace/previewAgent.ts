/**
 * Preview Agent (workspace side) — talks to the bootstrap engine injected
 * into the preview iframe (src/injected/bootstrap.ts).
 *
 * On every `cms:agent-ready` (each document the iframe loads) it pushes the
 * initial module — the compiled source of cmsAgentModule — via
 * `cms:load-module`. It also exposes evalInPreview() to run code inside the
 * page and routes the module's events (navigation/selection/element/…) to
 * handlers registered with onPreviewAgentEvent().
 *
 * Trust: messages are accepted only when they come from the preview iframe's
 * contentWindow AND its origin; outgoing messages pin targetOrigin to that
 * origin (we are shipping evaluatable code — never post it to '*').
 */

import type { AgentEnvelope } from '@/injected/protocol';

const REQUEST_TIMEOUT_MS = 15_000;

export const getPreviewIframe = (): HTMLIFrameElement | null =>
  document.getElementById('preview-iframe') as HTMLIFrameElement | null;

const previewOrigin = (iframe: HTMLIFrameElement): string | null => {
  try {
    return new URL(iframe.src).origin;
  } catch {
    return null;
  }
};

const postToPreview = (msg: Record<string, unknown>): boolean => {
  const iframe = getPreviewIframe();
  const origin = iframe ? previewOrigin(iframe) : null;
  if (!iframe?.contentWindow || !origin) return false;
  iframe.contentWindow.postMessage(msg, origin);
  return true;
};

// ── Request/response (cms:eval, cms:load-module) ────────────────────────────

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let seq = 0;

const request = (msg: Record<string, unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = `req-${++seq}`;
    if (!postToPreview({ ...msg, id })) {
      reject(new Error('Preview iframe is not available'));
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Preview agent request timed out: ${String(msg.type)}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });

const settle = (id: string, ok: boolean, value: unknown, error?: string): void => {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(value);
  else entry.reject(new Error(error || 'Preview agent request failed'));
};

/** Evaluate code inside the preview page. `code` is an async function body —
 *  it may use `await` and must `return` to produce a value. */
export const evalInPreview = (code: string): Promise<unknown> =>
  request({ type: 'cms:eval', code });

// ── Module push ──────────────────────────────────────────────────────────────

/** The module ships as a URL-addressable build artifact (an Astro endpoint
 *  serving the compiled function text); fetched once, then submitted to the
 *  bootstrap on every cms:agent-ready. */
const MODULE_URL = '/injected-agent-module.js';
let moduleSourcePromise: Promise<string> | null = null;

const fetchModuleSource = (): Promise<string> => {
  moduleSourcePromise ??= fetch(MODULE_URL).then((res) => {
    if (!res.ok) throw new Error(`GET ${MODULE_URL} → ${res.status}`);
    return res.text();
  });
  // Allow a retry after a failed fetch instead of caching the rejection
  moduleSourcePromise.catch(() => {
    moduleSourcePromise = null;
  });
  return moduleSourcePromise;
};

const pushModule = (): void => {
  void fetchModuleSource()
    .then((source) => request({ type: 'cms:load-module', source }))
    .catch((err) => {
      console.error('[preview-agent] module load failed:', err);
    });
};

// ── Fire-and-forget commands ─────────────────────────────────────────────────

export const startElementPick = (): void => {
  postToPreview({ type: 'cms:start-element-pick' });
};

export const cancelElementPick = (): void => {
  postToPreview({ type: 'cms:cancel-element-pick' });
};

// ── Event routing (module → workspace) ───────────────────────────────────────

type AgentEventHandler = (data: AgentEnvelope) => void;
const eventHandlers = new Map<string, AgentEventHandler[]>();

export const onPreviewAgentEvent = (type: string, handler: AgentEventHandler): void => {
  const list = eventHandlers.get(type) ?? [];
  list.push(handler);
  eventHandlers.set(type, list);
};

export const registerPreviewAgent = (): void => {
  window.addEventListener('message', (event: MessageEvent) => {
    // Accept messages ONLY from the current preview iframe, at its own origin
    const iframe = getPreviewIframe();
    if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;
    if (event.origin !== previewOrigin(iframe)) return;

    const data = event.data as AgentEnvelope | null;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'cms:agent-ready':
        pushModule();
        break;
      case 'cms:module-loaded':
      case 'cms:eval-result':
        if (typeof data.id === 'string') {
          settle(
            data.id,
            data.ok === true,
            data.value,
            typeof data.error === 'string' ? data.error : undefined,
          );
        }
        break;
      default:
        for (const handler of eventHandlers.get(data.type) ?? []) handler(data);
    }
  });
};
