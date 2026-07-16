/**
 * Initial injected-agent module — navigation beacon, text-selection
 * "Chat about this" button, and the element picker. The workspace pushes this
 * function's SOURCE TEXT (cmsAgentModule.toString()) into the preview iframe,
 * where the bootstrap instantiates it with the agent API (cms:load-module).
 *
 * SELF-CONTAINED: shipped as source text — must not reference anything from
 * module scope except erased types. It is also re-loadable: everything it
 * attaches is undone in agent.onTeardown so a re-push replaces it cleanly.
 *
 * Protocol (module part, engine messages are documented in protocol.ts):
 *   → {type:'cms:navigation', url, route}
 *   → {type:'cms:selection', anchor:{exact,prefix,suffix,cssPath}, url, route}
 *   → {type:'cms:element', element:{tag,id,classes,headingPath,outerHtmlExcerpt}, url, route}
 *   → {type:'cms:pick-cancel'}                    (Esc / cancel during element pick)
 *   ← {type:'cms:start-element-pick'}
 *   ← {type:'cms:cancel-element-pick'}
 */

import type { AgentApi } from './protocol';

export function cmsAgentModule(agent: AgentApi): void {
  'use strict';

  const MAX_EXACT = 500;
  const MAX_AFFIX = 30;

  const post = agent.post;
  const safe = agent.safe;

  // ── Styles ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.setAttribute('data-cms-overlay', '');
  style.textContent =
    '.cms-ov-btn{position:absolute;z-index:2147483646;padding:4px 10px;border-radius:999px;' +
    'border:1px solid #7852ee;background:#1e1e1e;color:#eee;font:12px/1.4 system-ui,sans-serif;' +
    'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap}' +
    '.cms-ov-btn:hover{background:#2a2a2a}' +
    '.cms-ov-hl{position:fixed;z-index:2147483645;pointer-events:none;' +
    'outline:2px solid #7852ee;outline-offset:-1px;background:rgba(120,82,238,.12);border-radius:2px}';
  (document.head || document.documentElement).appendChild(style);
  agent.onTeardown(() => style.remove());

  const isOurs = (node: EventTarget | null): boolean => {
    if (!(node instanceof Element)) return false;
    return node.hasAttribute('data-cms-overlay') || !!node.closest('[data-cms-overlay]');
  };

  // Track listeners so teardown can remove them all.
  const listeners: Array<[EventTarget, string, EventListener, boolean?]> = [];
  const listen = (
    target: EventTarget,
    type: string,
    fn: EventListener,
    capture?: boolean,
  ): void => {
    target.addEventListener(type, fn, capture);
    listeners.push([target, type, fn, capture]);
  };
  agent.onTeardown(() => {
    for (const [target, type, fn, capture] of listeners) {
      target.removeEventListener(type, fn, capture);
    }
  });

  // ── Navigation reporting ──────────────────────────────────────────────
  const nav = safe(() => {
    post({ type: 'cms:navigation', url: location.href, route: location.pathname });
  });

  nav(); // bootstrap already waited for DOMContentLoaded before loading us
  listen(document, 'astro:page-load', () => nav());
  listen(window, 'popstate', () => nav());
  const origPushState = history.pushState;
  try {
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = origPushState.apply(this, args);
      nav();
      return r;
    };
    agent.onTeardown(() => {
      history.pushState = origPushState;
    });
  } catch {
    /* ignore */
  }

  // ── Simple CSS path ───────────────────────────────────────────────────
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (parent) {
        let sameTag = 0;
        let index = 0;
        for (const child of Array.from(parent.children)) {
          if (child.tagName === node.tagName) {
            sameTag++;
            if (child === node) index = sameTag;
          }
        }
        if (sameTag > 1) part += `:nth-of-type(${index})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  // ── Text selection → "Chat about this" button ─────────────────────────
  let selBtn: HTMLButtonElement | null = null;
  let selDebounce: ReturnType<typeof setTimeout> | null = null;

  const hideSelBtn = (): void => {
    selBtn?.remove();
    selBtn = null;
  };
  agent.onTeardown(hideSelBtn);

  interface SelectionAnchor {
    exact: string;
    prefix: string;
    suffix: string;
    cssPath?: string;
  }

  const buildAnchor = (sel: Selection): SelectionAnchor | null => {
    const exact = sel.toString();
    if (!exact.trim()) return null;
    const anchor: SelectionAnchor = { exact: exact.slice(0, MAX_EXACT), prefix: '', suffix: '' };
    try {
      const range = sel.getRangeAt(0);
      const sc = range.startContainer;
      const ec = range.endContainer;
      if (sc.nodeType === 3) {
        anchor.prefix = (sc.textContent || '').slice(
          Math.max(0, range.startOffset - MAX_AFFIX),
          range.startOffset,
        );
      }
      if (ec.nodeType === 3) {
        anchor.suffix = (ec.textContent || '').slice(range.endOffset, range.endOffset + MAX_AFFIX);
      }
      const el = sc.nodeType === 1 ? (sc as Element) : sc.parentElement;
      if (el) anchor.cssPath = cssPath(el);
    } catch {
      /* partial anchor is fine */
    }
    return anchor;
  };

  const showSelBtn = safe(() => {
    hideSelBtn();
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const anchor = buildAnchor(sel);
    if (!anchor) return;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cms-ov-btn';
    btn.setAttribute('data-cms-overlay', '');
    btn.textContent = '💬 Chat about this';
    btn.style.left = `${Math.max(4, rect.left + window.scrollX)}px`;
    btn.style.top = `${Math.max(4, rect.bottom + window.scrollY + 6)}px`;
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener(
      'click',
      safe((ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        post({ type: 'cms:selection', anchor, url: location.href, route: location.pathname });
        hideSelBtn();
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          /* ignore */
        }
      }) as EventListener,
    );
    document.body.appendChild(btn);
    selBtn = btn;
  });

  const queueSelBtn = (): void => {
    if (selDebounce) clearTimeout(selDebounce);
    selDebounce = setTimeout(() => showSelBtn(), 250);
  };

  listen(
    document,
    'mouseup',
    safe((ev: Event) => {
      if (isOurs(ev.target)) return;
      queueSelBtn();
    }) as EventListener,
  );
  listen(
    document,
    'selectionchange',
    safe(() => {
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed) hideSelBtn();
      else queueSelBtn();
    }) as EventListener,
  );

  // ── Element picker ────────────────────────────────────────────────────
  let picking = false;
  let hlBox: HTMLDivElement | null = null;

  const ensureHlBox = (): HTMLDivElement => {
    if (!hlBox) {
      hlBox = document.createElement('div');
      hlBox.className = 'cms-ov-hl';
      hlBox.setAttribute('data-cms-overlay', '');
      document.body.appendChild(hlBox);
    }
    return hlBox;
  };

  const moveHlBox = (el: Element): void => {
    const box = ensureHlBox();
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    box.style.display = 'block';
  };

  const stopPick = (cancelled: boolean): void => {
    picking = false;
    hlBox?.remove();
    hlBox = null;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    if (cancelled) post({ type: 'cms:pick-cancel' });
  };
  agent.onTeardown(() => stopPick(false));

  const headingPathFor = (el: Element): string[] => {
    const headings: string[] = [];
    try {
      for (const h of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
        // headings that precede (or contain) the element in document order
        const pos = h.compareDocumentPosition(el);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING || pos & Node.DOCUMENT_POSITION_CONTAINED_BY) {
          headings.push((h.textContent || '').trim().slice(0, 120));
        }
      }
    } catch {
      /* ignore */
    }
    return headings.slice(-3);
  };

  const elementInfo = (el: Element): Record<string, unknown> => {
    const info: Record<string, unknown> = { tag: el.tagName.toLowerCase() };
    if (el.id) info.id = el.id;
    try {
      const classes = Array.from(el.classList).slice(0, 5);
      if (classes.length) info.classes = classes;
    } catch {
      /* ignore */
    }
    info.headingPath = headingPathFor(el);
    try {
      let html = (el as HTMLElement).outerHTML || '';
      html = html.replace(/<script[\s\S]*?(?:<\/script>|$)/gi, '');
      info.outerHtmlExcerpt = html.slice(0, 500);
    } catch {
      /* ignore */
    }
    return info;
  };

  const onPickMove = safe((ev: Event) => {
    if (!picking) return;
    const el = ev.target as Element | null;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    moveHlBox(el);
  }) as EventListener;

  const onPickClick = safe((ev: Event) => {
    if (!picking) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = ev.target as Element | null;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    post({
      type: 'cms:element',
      element: elementInfo(el),
      url: location.href,
      route: location.pathname,
    });
    stopPick(false);
  }) as EventListener;

  const onPickKey = safe((ev: KeyboardEvent) => {
    if (picking && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      stopPick(true);
    }
  }) as EventListener;

  agent.on(
    'cms:start-element-pick',
    safe(() => {
      if (picking) return;
      picking = true;
      ensureHlBox();
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKey, true);
    }),
  );

  agent.on(
    'cms:cancel-element-pick',
    safe(() => {
      if (picking) stopPick(true);
    }),
  );
}
