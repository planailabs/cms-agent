/**
 * Element picker — armed via cms:start-element-pick, highlights the hovered
 * element, and posts cms:element (tag/id/classes/headingPath/HTML excerpt)
 * for the clicked one. Esc or cms:cancel-element-pick exits with
 * cms:pick-cancel so the workspace can un-arm its toolbar button.
 */
import type { AgentApi } from '../protocol';
import { createHelpBanner, type HelpBanner } from './banner';
import { cfg } from './config';
import { isOurs } from './dom';

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

export const elementInfo = (el: Element): Record<string, unknown> => {
  const info: Record<string, unknown> = { tag: el.tagName.toLowerCase() };
  const text = (
    (el as HTMLElement).innerText ||
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (text) info.text = text.slice(0, 160);
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

export const initPicker = (agent: AgentApi): void => {
  let picking = false;
  let hlBox: HTMLDivElement | null = null;
  let help: HelpBanner | null = null;

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

  const onPickMove = agent.safe((ev: Event) => {
    if (!picking) return;
    const el = ev.target as Element | null;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    moveHlBox(el);
  }) as EventListener;

  const onPickClick = agent.safe((ev: Event) => {
    if (!picking) return;
    const el = ev.target as Element | null;
    // Ours-check BEFORE swallowing the event — a capture-phase
    // stopPropagation would keep the banner's × from ever firing.
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    ev.preventDefault();
    ev.stopPropagation();
    agent.post({
      type: 'cms:element',
      element: elementInfo(el),
      url: location.href,
      route: location.pathname,
    });
    stopPick(false);
  }) as EventListener;

  const onPickKey = agent.safe((ev: KeyboardEvent) => {
    if (picking && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      stopPick(true);
    }
  }) as EventListener;

  const stopPick = (cancelled: boolean): void => {
    picking = false;
    hlBox?.remove();
    hlBox = null;
    help?.remove();
    help = null;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    if (cancelled) agent.post({ type: 'cms:pick-cancel' });
  };
  agent.onTeardown(() => stopPick(false));

  agent.on(
    'cms:start-element-pick',
    agent.safe(() => {
      if (picking) return;
      picking = true;
      ensureHlBox();
      help = createHelpBanner('pick', cfg.labels.pickInstruction);
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKey, true);
    }),
  );

  agent.on(
    'cms:cancel-element-pick',
    agent.safe(() => {
      if (picking) stopPick(true);
    }),
  );
};
