/**
 * Request/response over postMessage to a preview iframe.
 *
 * Two callers talk to preview frames — the live preview agent and the compare
 * view's scroll/marker sync — and each had grown its own copy of the same
 * plumbing: derive the frame's origin from its src, mint a request id, keep a
 * pending map, arm a timeout, settle on the reply, and check that an incoming
 * message really came from the frame it was sent to.
 *
 * Only that transport is shared. What the two do with it is genuinely
 * different (one owns a tab's overlay lifecycle, the other aligns two
 * documents), and merging those would couple them for no gain.
 *
 * The origin check is a security boundary, not a detail: a preview renders
 * the SITE's code, so a reply is only trusted from the frame this side posted
 * to, at that frame's own origin.
 */

/** Origin of the document an iframe points at, or null when it has no usable
 *  src (never posted to, never trusted). */
export const frameOrigin = (iframe: HTMLIFrameElement): string | null => {
  try {
    return new URL(iframe.src).origin;
  } catch {
    return null;
  }
};

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface FrameRpcOptions {
  /** Request-id prefix, so two transports in one page never collide. */
  prefix: string;
  timeoutMs: number;
  /** Message when the frame cannot be posted to at all. */
  unavailable: string;
  /** Message when the frame never answered. */
  timedOut: (msg: Record<string, unknown>, iframe: HTMLIFrameElement) => string;
}

export interface FrameRpc {
  /** Post without expecting an answer. False when the frame is unreachable. */
  post(iframe: HTMLIFrameElement | null, msg: Record<string, unknown>): boolean;
  /** Post with a generated id and wait for settle() to answer it. */
  request(iframe: HTMLIFrameElement | null, msg: Record<string, unknown>): Promise<unknown>;
  /** Answer a pending request. Unknown ids are ignored — a late reply to a
   *  timed-out call must not throw. */
  settle(id: string, ok: boolean, value: unknown, error?: string): void;
  /** The frame an event came from, restricted to `frames` and origin-pinned.
   *  Returns null for anything else, which is what a caller should ignore. */
  senderOf(event: MessageEvent, frames: Array<HTMLIFrameElement | null>): HTMLIFrameElement | null;
}

export function createFrameRpc(options: FrameRpcOptions): FrameRpc {
  const pending = new Map<string, PendingCall>();
  let seq = 0;

  const post: FrameRpc['post'] = (iframe, msg) => {
    const origin = iframe ? frameOrigin(iframe) : null;
    if (!iframe?.contentWindow || !origin) return false;
    iframe.contentWindow.postMessage(msg, origin);
    return true;
  };

  return {
    post,

    request: (iframe, msg) =>
      new Promise((resolve, reject) => {
        const id = `${options.prefix}-${++seq}`;
        if (!post(iframe, { ...msg, id })) {
          reject(new Error(options.unavailable));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(options.timedOut(msg, iframe!)));
        }, options.timeoutMs);
        pending.set(id, { resolve, reject, timer });
      }),

    settle: (id, ok, value, error) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (ok) entry.resolve(value);
      else entry.reject(new Error(error || options.unavailable));
    },

    senderOf: (event, frames) => {
      if (!event.source) return null;
      const frame = frames.find((f) => f && f.contentWindow === event.source);
      if (!frame) return null;
      return event.origin === frameOrigin(frame) ? frame : null;
    },
  };
}
