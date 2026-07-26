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

import type { EditTool } from '@/injected/annotate';
import type { AgentEnvelope } from '@/injected/protocol';
import { t, uiLocale } from '@/lib/i18n';
import { store } from '../chat/app/store';
import { getPreviewIframe, getPreviewIframes } from './previewFrames';

export { getPreviewIframe } from './previewFrames';

const REQUEST_TIMEOUT_MS = 15_000;

const previewOrigin = (iframe: HTMLIFrameElement): string | null => {
  try {
    return new URL(iframe.src).origin;
  } catch {
    return null;
  }
};

/** Post to a specific iframe (default: the active tab's). */
const postToPreview = (
  msg: Record<string, unknown>,
  iframe: HTMLIFrameElement | null = getPreviewIframe(),
): boolean => {
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

const request = (
  msg: Record<string, unknown>,
  iframe: HTMLIFrameElement | null = getPreviewIframe(),
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = `req-${++seq}`;
    if (!postToPreview({ ...msg, id }, iframe)) {
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

const pushModule = (iframe: HTMLIFrameElement): void => {
  void fetchModuleSource()
    .then((source) => request({ type: 'cms:load-module', source }, iframe))
    .then(() => {
      pushConfig();
      // An iframe (re)load during an active edit session gets the session
      // back — the parent holds the latest annotation set (cms:edit-changed).
      if (store.state.workspace.elementEdit.active && iframe === getPreviewIframe()) {
        postEditStart();
      }
    })
    .catch((err) => {
      console.error('[preview-agent] module load failed:', err);
    });
};

// ── Theme/locale sync (main window → overlay) ───────────────────────────────

/** Sends the workspace's effective theme + locale-resolved overlay labels
 *  to EVERY loaded tab (hidden tabs must follow theme changes too). */
const pushConfig = (): void => {
  const locale = uiLocale();
  const msg = {
    type: 'cms:config',
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    locale,
    labels: {
      chatAboutThis: t(locale, 'workspace.injected.chatAboutThis'),
      pickInstruction: t(locale, 'workspace.injected.pickInstruction'),
      editInstruction: t(locale, 'workspace.injected.editInstruction'),
      commentPlaceholder: t(locale, 'workspace.injected.commentPlaceholder'),
    },
  };
  for (const iframe of getPreviewIframes()) postToPreview(msg, iframe);
};

// ── Fire-and-forget commands ─────────────────────────────────────────────────

export const startElementPick = (): void => {
  postToPreview({ type: 'cms:start-element-pick' });
};

export const cancelElementPick = (): void => {
  postToPreview({ type: 'cms:cancel-element-pick' });
};

/** Arm edit mode in the active tab, restoring the parent-held annotations. */
export const postEditStart = (): void => {
  const ee = store.state.workspace.elementEdit;
  postToPreview({
    type: 'cms:edit-start',
    tool: ee.tool,
    annotations: ee.annotations ?? undefined,
  });
};

export const postEditStop = (): void => {
  postToPreview({ type: 'cms:edit-stop' });
};

export const postEditTool = (tool: EditTool): void => {
  postToPreview({ type: 'cms:edit-tool', tool });
};

export const postEditUndo = (): void => {
  postToPreview({ type: 'cms:edit-undo' });
};

export const postEditClear = (): void => {
  postToPreview({ type: 'cms:edit-clear' });
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
  // Follow the main window's theme (data-theme) and locale (lang) live
  new MutationObserver(() => pushConfig()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'lang'],
  });

  window.addEventListener('message', (event: MessageEvent) => {
    // Accept messages ONLY from one of the managed per-tab preview iframes,
    // at that iframe's own origin.
    const iframe = event.source
      ? getPreviewIframes().find((f) => f.contentWindow === event.source)
      : undefined;
    if (!iframe) return;
    if (event.origin !== previewOrigin(iframe)) return;

    const data = event.data as AgentEnvelope | null;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'cms:agent-ready':
        // Reply to the SOURCE tab: hidden tabs (created by remote tab sync
        // or a branch switch) need the overlay module too.
        pushModule(iframe);
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
        // Interaction events (navigation/selection/…) only from the VISIBLE
        // tab — a hidden tab must not clobber the address bar or picker.
        if (iframe !== getPreviewIframe()) return;
        for (const handler of eventHandlers.get(data.type) ?? []) handler(data);
    }
  });
};
