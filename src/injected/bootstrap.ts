/**
 * Injected-agent bootstrap — the two-way eval engine running inside every
 * preview page. Served at /injected-cms-agent.js (see
 * src/pages/injected-cms-agent.js.ts, which serializes cmsAgentBootstrap via
 * .toString()), injected by the preview proxy before </head>.
 *
 * SELF-CONTAINED: this function is shipped as its own source text, so it must
 * not reference anything from module scope (imports, constants, helpers).
 * Types are fine — they erase.
 *
 * Security model:
 *  - dormant unless framed;
 *  - the trusted origin is derived from this script's own src (the CMS host
 *    that the proxy injected) — eval/module messages are accepted only from
 *    window.parent AND that origin, and everything we post is targeted at it;
 *  - eval is parent→child only; the preview page can never run code upstairs.
 */

export function cmsAgentBootstrap(): void {
  'use strict';

  try {
    if (window.parent === window) return; // not framed → dormant
    if ((window as { __cmsAgent?: boolean }).__cmsAgent) return; // double-inject guard
    (window as { __cmsAgent?: boolean }).__cmsAgent = true;
  } catch {
    return;
  }

  // The CMS origin = origin of this script's own URL (proxy-injected, so it
  // always points at the CMS host, which is also the workspace's origin).
  let cmsOrigin = '';
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    if (src) cmsOrigin = new URL(src).origin;
  } catch {
    /* fall through */
  }
  if (!cmsOrigin) return; // can't establish trust → stay dormant

  type Handler = (data: Record<string, unknown>) => void;
  const handlers = new Map<string, Handler[]>();
  const teardowns: Array<() => void> = [];

  const post = (msg: Record<string, unknown>): void => {
    try {
      window.parent.postMessage(msg, cmsOrigin);
    } catch {
      /* never break the host page */
    }
  };

  const safe =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R | undefined => {
      try {
        return fn(...args);
      } catch {
        return undefined;
      }
    };

  const agent = {
    origin: cmsOrigin,
    post,
    safe,
    on(type: string, handler: Handler): void {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    onTeardown(fn: () => void): void {
      teardowns.push(fn);
    },
  };

  const teardownModule = (): void => {
    for (const fn of teardowns.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    handlers.clear();
  };

  const loadModule = (id: string, source: string): void => {
    teardownModule();
    try {
      // source is "(function(agent){…})" — parenthesized function expression
      const factory = new Function(`"use strict"; return (${source});`)() as (
        a: typeof agent,
      ) => void;
      factory(agent);
      post({ type: 'cms:module-loaded', id, ok: true });
    } catch (err) {
      post({ type: 'cms:module-loaded', id, ok: false, error: String(err) });
    }
  };

  // Async so evaluated code can use await; it must `return` to produce a value.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (a: typeof agent) => Promise<unknown>;

  const replyEval = (id: string, ok: boolean, value: unknown, error?: string): void => {
    try {
      window.parent.postMessage({ type: 'cms:eval-result', id, ok, value, error }, cmsOrigin);
    } catch {
      // value not structured-cloneable (DOM node, function, …) → stringify
      post({ type: 'cms:eval-result', id, ok, value: String(value), error });
    }
  };

  const runEval = async (id: string, code: string): Promise<void> => {
    try {
      const value = await new AsyncFunction('agent', `"use strict";\n${code}`)(agent);
      replyEval(id, true, value);
    } catch (err) {
      replyEval(id, false, undefined, String(err));
    }
  };

  window.addEventListener('message', (ev: MessageEvent) => {
    try {
      if (ev.source !== window.parent || ev.origin !== cmsOrigin) return;
      const data = ev.data as { type?: string; id?: string; source?: string; code?: string } | null;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

      if (data.type === 'cms:load-module') {
        if (typeof data.id === 'string' && typeof data.source === 'string') {
          loadModule(data.id, data.source);
        }
      } else if (data.type === 'cms:eval') {
        if (typeof data.id === 'string' && typeof data.code === 'string') {
          void runEval(data.id, data.code);
        }
      } else {
        for (const handler of handlers.get(data.type) ?? []) {
          try {
            handler(data as Record<string, unknown>);
          } catch {
            /* module bug must not break the page */
          }
        }
      }
    } catch {
      /* ignore */
    }
  });

  const ready = safe(() => {
    post({ type: 'cms:agent-ready', url: location.href, route: location.pathname });
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ready());
  } else {
    ready();
  }
}
