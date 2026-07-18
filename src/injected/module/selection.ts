/**
 * Text selection → floating "💬 Chat about this" button → cms:selection with
 * a text-quote anchor (exact + prefix/suffix + CSS path).
 */
import type { AgentApi } from '../protocol';
import { cfg, onConfigChange } from './config';
import { cssPath, isOurs, type Listen } from './dom';

const MAX_EXACT = 500;
const MAX_AFFIX = 30;

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

export const initSelection = (agent: AgentApi, listen: Listen): void => {
  let selBtn: HTMLButtonElement | null = null;
  let selDebounce: ReturnType<typeof setTimeout> | null = null;

  const hideSelBtn = (): void => {
    selBtn?.remove();
    selBtn = null;
  };
  agent.onTeardown(hideSelBtn);

  const showSelBtn = agent.safe(() => {
    hideSelBtn();
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const anchor = buildAnchor(sel);
    if (!anchor) return;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cms-ov-btn${cfg.theme === 'light' ? ' cms-ov-light' : ''}`;
    btn.setAttribute('data-cms-overlay', '');
    btn.textContent = cfg.labels.chatAboutThis;
    btn.style.left = `${Math.max(4, rect.left + window.scrollX)}px`;
    btn.style.top = `${Math.max(4, rect.bottom + window.scrollY + 6)}px`;
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener(
      'click',
      agent.safe((ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
        agent.post({
          type: 'cms:selection',
          anchor,
          url: location.href,
          route: location.pathname,
        });
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

  // Live theme/locale switch in the main window — restyle a visible button
  onConfigChange(() => {
    if (!selBtn) return;
    selBtn.classList.toggle('cms-ov-light', cfg.theme === 'light');
    selBtn.textContent = cfg.labels.chatAboutThis;
  });

  const queueSelBtn = (): void => {
    if (selDebounce) clearTimeout(selDebounce);
    selDebounce = setTimeout(() => showSelBtn(), 250);
  };

  listen(
    document,
    'mouseup',
    agent.safe((ev: Event) => {
      if (isOurs(ev.target)) return;
      queueSelBtn();
    }) as EventListener,
  );
  listen(
    document,
    'selectionchange',
    agent.safe(() => {
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed) hideSelBtn();
      else queueSelBtn();
    }) as EventListener,
  );
};
