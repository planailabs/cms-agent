/**
 * Element-edit mode — armed via cms:edit-start; the user drags elements to
 * new positions (move tool), draws freehand strokes (draw tool), and drops
 * numbered comments (comment tool). Rendering goes through the shared
 * annotation renderer (../annotate.ts) so the live view matches the server's
 * handoff screenshot replay exactly.
 *
 * Interactions on existing annotations work in EVERY tool via coordinate
 * hit-testing (hitTestAnnotations — no pointer-events juggling): hovering a
 * pin shows its comment in a bubble, clicking any annotation selects it and
 * offers a 🗑 button; clicking away from an open comment input commits it.
 * Undo is a snapshot stack (arbitrary deletes make positional undo fragile).
 *
 * The parent is the source of truth: every mutation posts the FULL annotation
 * set as cms:edit-changed, and cms:edit-start accepts a prior set back (an
 * iframe reload mid-edit restores seamlessly).
 *
 *   parent → child  cms:edit-start {annotations?, tool?}
 *   parent → child  cms:edit-stop | cms:edit-undo | cms:edit-clear
 *   parent → child  cms:edit-tool {tool: 'move'|'draw'|'comment'}
 *   child → parent  cms:edit-changed {annotations}
 *   child → parent  cms:edit-stopped            (Esc inside the page)
 */
import {
  applyAnnotations,
  clearAnnotations,
  emptyAnnotations,
  ensureOverlayCanvas,
  hitTestAnnotations,
  removeAnnotation,
  strokeBbox,
  type AnnotatedElement,
  type AnnotationSelection,
  type EditAnnotations,
  type EditTool,
  type ElementMove,
} from '../annotate';
import type { AgentApi } from '../protocol';
import { cfg, onConfigChange } from './config';
import { cssPath, isOurs, type Listen } from './dom';
import { elementInfo } from './picker';

const TOOLS: EditTool[] = ['cursor', 'move', 'draw', 'comment'];
const MIN_DRAG_PX = 3;

export const initEditMode = (agent: AgentApi, listen: Listen): void => {
  let active = false;
  let tool: EditTool = 'cursor';
  let ann: EditAnnotations = emptyAnnotations();
  /** Snapshot undo stack — one deep copy per mutation. */
  const history: EditAnnotations[] = [];
  let selected: AnnotationSelection | null = null;

  let banner: HTMLDivElement | null = null;
  let hlBox: HTMLDivElement | null = null;

  const snapshot = (): void => {
    history.push(JSON.parse(JSON.stringify(ann)) as EditAnnotations);
  };

  // ── Overlay chrome (module-owned; survives renderer re-renders) ───────────

  const chromeNode = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
  ): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    el.className = className;
    el.setAttribute('data-cms-overlay', '');
    return el;
  };

  let bubble: HTMLDivElement | null = null;
  const hideBubble = (): void => {
    bubble?.remove();
    bubble = null;
  };
  const showBubble = (index: number): void => {
    const comment = ann.comments[index];
    if (!comment) {
      hideBubble();
      return;
    }
    if (!bubble) {
      bubble = chromeNode('div', 'cms-ov-bubble');
      document.body.appendChild(bubble);
    }
    bubble.textContent = `${comment.n}. ${comment.text}`;
    bubble.classList.toggle('cms-ov-light', cfg.theme === 'light');
    bubble.style.left = `${comment.x + 16}px`;
    bubble.style.top = `${comment.y + 14}px`;
  };

  let bin: HTMLButtonElement | null = null;
  let ring: HTMLDivElement | null = null;
  const hideSelectionChrome = (): void => {
    bin?.remove();
    bin = null;
    ring?.remove();
    ring = null;
  };

  const deleteAt = (sel: AnnotationSelection): void => {
    snapshot();
    removeAnnotation(ann, sel);
    selected = null;
    hideBubble();
    render();
  };

  /** 🗑 button that deletes the given annotation (indices are regenerated on
   *  every render, so the captured selection stays valid until then). */
  const makeBin = (x: number, y: number, sel: AnnotationSelection): HTMLButtonElement => {
    const b = chromeNode('button', 'cms-ov-bin');
    b.type = 'button';
    b.textContent = '🗑';
    b.style.left = `${Math.max(4, x)}px`;
    b.style.top = `${Math.max(4, y)}px`;
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    b.addEventListener(
      'click',
      agent.safe((ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
        deleteAt(sel);
      }) as EventListener,
    );
    document.body.appendChild(b);
    return b;
  };

  /** Cursor mode: every comment bubble and every annotation's 🗑, no clicks
   *  needed. */
  let allChrome: HTMLElement[] = [];
  const hideAllChrome = (): void => {
    for (const el of allChrome) el.remove();
    allChrome = [];
  };
  const showAllChrome = (): void => {
    hideAllChrome();
    ann.comments.forEach((c, i) => {
      const bub = chromeNode('div', 'cms-ov-bubble');
      bub.textContent = `${c.n}. ${c.text}`;
      bub.classList.toggle('cms-ov-light', cfg.theme === 'light');
      bub.style.left = `${c.x + 16}px`;
      bub.style.top = `${c.y + 14}px`;
      document.body.appendChild(bub);
      allChrome.push(bub, makeBin(c.x + 16, c.y - 30, { kind: 'comment', index: i }));
    });
    ann.strokes.forEach((s, i) => {
      const box = strokeBbox(s);
      allChrome.push(makeBin(box.x + box.w + 8, box.y - 30, { kind: 'stroke', index: i }));
    });
    ann.moves.forEach((m, i) => {
      allChrome.push(
        makeBin(m.rect.x + m.dx + m.rect.w + 8, m.rect.y + m.dy - 30, { kind: 'move', index: i }),
      );
    });
  };

  /** Ring highlight + 🗑 button next to the selected annotation. */
  const showSelectionChrome = (): void => {
    hideSelectionChrome();
    if (!selected) return;
    let binX = 0;
    let binY = 0;
    if (selected.kind === 'comment') {
      const c = ann.comments[selected.index];
      if (!c) return;
      ring = chromeNode('div', 'cms-ov-ring cms-ov-ring--pin');
      ring.style.left = `${c.x - 15}px`;
      ring.style.top = `${c.y - 15}px`;
      ring.style.width = '30px';
      ring.style.height = '30px';
      binX = c.x + 16;
      binY = c.y - 30;
      showBubble(selected.index);
    } else if (selected.kind === 'stroke') {
      const s = ann.strokes[selected.index];
      if (!s) return;
      const box = strokeBbox(s);
      ring = chromeNode('div', 'cms-ov-ring');
      ring.style.left = `${box.x - 6}px`;
      ring.style.top = `${box.y - 6}px`;
      ring.style.width = `${box.w + 12}px`;
      ring.style.height = `${box.h + 12}px`;
      binX = box.x + box.w + 8;
      binY = box.y - 30;
    } else {
      const m = ann.moves[selected.index];
      if (!m) return;
      ring = chromeNode('div', 'cms-ov-ring');
      ring.style.left = `${m.rect.x + m.dx - 4}px`;
      ring.style.top = `${m.rect.y + m.dy - 4}px`;
      ring.style.width = `${m.rect.w + 8}px`;
      ring.style.height = `${m.rect.h + 8}px`;
      binX = m.rect.x + m.dx + m.rect.w + 8;
      binY = m.rect.y + m.dy - 30;
    }
    document.body.appendChild(ring);
    bin = makeBin(binX, binY, selected);
  };

  const hideBubbleUnlessSelected = (): void => {
    if (selected?.kind !== 'comment') hideBubble();
  };

  const select = (sel: AnnotationSelection | null): void => {
    selected = sel;
    showSelectionChrome();
    hideBubbleUnlessSelected();
  };

  // ── Rendering ──────────────────────────────────────────────────────────────

  /** Draw tool needs the (renderer-owned) canvas to take pointer events. */
  const syncCanvasMode = (): void => {
    const canvas = ensureOverlayCanvas(document);
    const drawing = active && tool === 'draw';
    canvas.style.pointerEvents = drawing ? 'auto' : 'none';
    canvas.style.cursor = drawing ? 'crosshair' : '';
  };

  const render = (post = true): void => {
    ann.viewport = { width: window.innerWidth, height: window.innerHeight };
    applyAnnotations(document, ann);
    syncCanvasMode();
    if (tool === 'cursor') {
      hideSelectionChrome();
      showAllChrome();
    } else {
      hideAllChrome();
      showSelectionChrome();
    }
    if (post) agent.post({ type: 'cms:edit-changed', annotations: ann });
  };

  const showHl = (el: Element): void => {
    if (!hlBox) {
      hlBox = document.createElement('div');
      hlBox.className = 'cms-ov-hl';
      hlBox.setAttribute('data-cms-overlay', '');
      document.body.appendChild(hlBox);
    }
    const r = el.getBoundingClientRect();
    hlBox.style.left = `${r.left}px`;
    hlBox.style.top = `${r.top}px`;
    hlBox.style.width = `${r.width}px`;
    hlBox.style.height = `${r.height}px`;
    hlBox.style.display = 'block';
  };
  const hideHl = (): void => {
    hlBox?.remove();
    hlBox = null;
  };

  // ── Move tool ──────────────────────────────────────────────────────────────

  interface Drag {
    el: HTMLElement;
    selector: string;
    baseDx: number;
    baseDy: number;
    startX: number;
    startY: number;
    moved: boolean;
  }
  let drag: Drag | null = null;

  const moveEntry = (selector: string): ElementMove | undefined =>
    ann.moves.find((m) => m.selector === selector);

  const commitMove = (d: Drag, dx: number, dy: number): void => {
    snapshot();
    const existing = moveEntry(d.selector);
    if (existing) {
      existing.dx = dx;
      existing.dy = dy;
    } else {
      const r = d.el.getBoundingClientRect();
      ann.moves.push({
        selector: d.selector,
        element: elementInfo(d.el) as unknown as AnnotatedElement,
        dx,
        dy,
        // Original rect = current rect minus the base translate at drag start
        rect: {
          x: r.left + window.scrollX - d.baseDx,
          y: r.top + window.scrollY - d.baseDy,
          w: r.width,
          h: r.height,
        },
      });
    }
    render();
  };

  // ── Draw tool ──────────────────────────────────────────────────────────────

  let stroke: Array<[number, number]> | null = null;

  const strokeCtx = (): CanvasRenderingContext2D | null =>
    ensureOverlayCanvas(document).getContext('2d');

  // ── Comment tool ───────────────────────────────────────────────────────────

  interface PendingComment {
    x: number;
    y: number;
    target: Element | null;
    box: HTMLDivElement;
    input: HTMLInputElement;
  }
  let pending: PendingComment | null = null;

  const closeCommentBox = (): void => {
    pending?.box.remove();
    pending = null;
  };

  /** Commit the open comment input (click-away, Enter): text → comment,
   *  empty → just close. */
  const commitPendingComment = agent.safe((): void => {
    if (!pending) return;
    const { x, y, target, input } = pending;
    const text = input.value.trim();
    closeCommentBox();
    if (!text) return;
    snapshot();
    const n = ann.comments.length + 1;
    const comment: EditAnnotations['comments'][number] = { n, x, y, text };
    if (target && !isOurs(target)) {
      comment.selector = cssPath(target);
      comment.element = elementInfo(target) as unknown as AnnotatedElement;
    }
    ann.comments.push(comment);
    render();
  }) as () => void;

  const openCommentBox = (x: number, y: number, target: Element | null): void => {
    closeCommentBox();
    const box = chromeNode('div', `cms-ov-edit-input${cfg.theme === 'light' ? ' cms-ov-light' : ''}`);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = cfg.labels.commentPlaceholder;
    input.maxLength = 2000;
    box.appendChild(input);
    box.style.left = `${Math.max(4, x)}px`;
    box.style.top = `${Math.max(4, y + 8)}px`;

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commitPendingComment();
      else if (ev.key === 'Escape') closeCommentBox();
    });
    // Keep page handlers away from clicks inside the box
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    box.addEventListener('click', (ev) => ev.stopPropagation());

    document.body.appendChild(box);
    pending = { x, y, target, box, input };
    input.focus();
  };

  // ── Undo / clear ───────────────────────────────────────────────────────────

  const undo = (): void => {
    const prev = history.pop();
    if (!prev) return;
    ann = prev;
    select(null);
    render();
  };

  const clear = (): void => {
    snapshot();
    ann.moves = [];
    ann.strokes = [];
    ann.comments = [];
    select(null);
    render();
  };

  // ── Start / stop ───────────────────────────────────────────────────────────

  const stop = (notifyParent: boolean): void => {
    if (!active) return;
    active = false;
    drag = null;
    stroke = null;
    selected = null;
    hideHl();
    hideBubble();
    hideSelectionChrome();
    hideAllChrome();
    closeCommentBox();
    banner?.remove();
    banner = null;
    clearAnnotations(document);
    if (notifyParent) agent.post({ type: 'cms:edit-stopped' });
  };

  const start = (data: Record<string, unknown>): void => {
    active = true;
    tool = TOOLS.includes(data.tool as EditTool) ? (data.tool as EditTool) : 'cursor';
    const prior = data.annotations as EditAnnotations | undefined;
    ann =
      prior && Array.isArray(prior.moves)
        ? { ...emptyAnnotations(), ...prior }
        : emptyAnnotations();
    ann.url = location.href;
    ann.route = location.pathname;
    history.length = 0;
    selected = null;
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'cms-ov-pick-help';
      banner.setAttribute('data-cms-overlay', '');
      document.body.appendChild(banner);
    }
    banner.textContent = cfg.labels.editInstruction;
    render(false);
  };

  onConfigChange(() => {
    if (banner) banner.textContent = cfg.labels.editInstruction;
    if (pending) {
      pending.box.classList.toggle('cms-ov-light', cfg.theme === 'light');
      pending.input.placeholder = cfg.labels.commentPlaceholder;
    }
  });

  // ── Pointer handlers (registered once; guarded on `active`) ────────────────

  const onPointerDown = agent.safe((ev: PointerEvent) => {
    if (!active) return;
    const target = ev.target as Element | null;
    // Click-away from an open comment input CREATES the comment (the box
    // stops propagation on its own pointerdown, so reaching here is "away").
    if (pending) commitPendingComment();
    if (tool === 'draw') {
      // The canvas is ours (pointer-events:auto while drawing)
      if (!(target instanceof HTMLCanvasElement)) return;
      ev.preventDefault();
      ev.stopPropagation();
      stroke = [[ev.pageX, ev.pageY]];
      return;
    }
    if (!target || target.nodeType !== 1 || isOurs(target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (tool === 'move' && target instanceof HTMLElement) {
      // A click on an existing annotation selects it (handled on click);
      // don't start a drag from a pin/stroke position.
      if (hitTestAnnotations(ann, ev.pageX, ev.pageY)?.kind === 'comment') return;
      const selector = cssPath(target);
      const existing = moveEntry(selector);
      drag = {
        el: target,
        selector,
        baseDx: existing?.dx ?? 0,
        baseDy: existing?.dy ?? 0,
        startX: ev.pageX,
        startY: ev.pageY,
        moved: false,
      };
    }
  }) as EventListener;

  const onPointerMove = agent.safe((ev: PointerEvent) => {
    if (!active) return;
    if (drag) {
      const dx = ev.pageX - drag.startX;
      const dy = ev.pageY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) >= MIN_DRAG_PX) drag.moved = true;
      if (drag.moved) {
        drag.el.style.translate = `${drag.baseDx + dx}px ${drag.baseDy + dy}px`;
        hideHl();
        hideBubble();
      }
      return;
    }
    if (stroke) {
      const [lx, ly] = stroke[stroke.length - 1];
      if (Math.hypot(ev.pageX - lx, ev.pageY - ly) < MIN_DRAG_PX) return;
      const ctx = strokeCtx();
      if (ctx) {
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(ev.pageX, ev.pageY);
        ctx.stroke();
      }
      stroke.push([ev.pageX, ev.pageY]);
      return;
    }
    // Hovering a pin reveals its comment (cursor mode shows them all already)
    if (tool !== 'cursor') {
      const hit = hitTestAnnotations(ann, ev.pageX, ev.pageY);
      if (hit?.kind === 'comment') showBubble(hit.index);
      else hideBubbleUnlessSelected();
    }
    // Hover highlight for the move tool
    if (tool !== 'move') return;
    const el = ev.target as Element | null;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    showHl(el);
  }) as EventListener;

  const onPointerUp = agent.safe((ev: PointerEvent) => {
    if (!active) return;
    if (drag) {
      const d = drag;
      drag = null;
      const dx = ev.pageX - d.startX;
      const dy = ev.pageY - d.startY;
      if (d.moved) commitMove(d, d.baseDx + dx, d.baseDy + dy);
      return;
    }
    if (stroke) {
      const s = stroke;
      stroke = null;
      if (s.length < 2) {
        // A click, not a stroke — select whatever annotation is under it
        select(hitTestAnnotations(ann, ev.pageX, ev.pageY));
        return;
      }
      snapshot();
      ann.strokes.push({ points: s });
      render();
    }
  }) as EventListener;

  const onClick = agent.safe((ev: MouseEvent) => {
    if (!active) return;
    const target = ev.target as Element | null;
    if (isOurs(target)) return;
    // Edit mode owns the page: no navigation / native click behavior
    ev.preventDefault();
    ev.stopPropagation();
    if (tool === 'draw') return; // selection handled on pointerup
    if (tool === 'cursor') return; // passive: all bubbles + bins already shown
    const hit = hitTestAnnotations(ann, ev.pageX, ev.pageY);
    if (hit) {
      select(hit);
      return;
    }
    if (selected) {
      select(null);
      return;
    }
    if (tool === 'comment') openCommentBox(ev.pageX, ev.pageY, target);
  }) as EventListener;

  const onKey = agent.safe((ev: KeyboardEvent) => {
    if (!active || ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (pending) closeCommentBox();
    else if (selected) select(null);
    else stop(true);
  }) as EventListener;

  listen(document, 'pointerdown', onPointerDown, true);
  listen(document, 'pointermove', onPointerMove, true);
  listen(document, 'pointerup', onPointerUp, true);
  listen(document, 'click', onClick, true);
  listen(document, 'keydown', onKey, true);

  // ── Messages ───────────────────────────────────────────────────────────────

  agent.on('cms:edit-start', agent.safe((data: Record<string, unknown>) => start(data)));
  agent.on('cms:edit-stop', agent.safe(() => stop(false)));
  agent.on(
    'cms:edit-tool',
    agent.safe((data: Record<string, unknown>) => {
      if (!TOOLS.includes(data.tool as EditTool)) return;
      tool = data.tool as EditTool;
      hideHl();
      closeCommentBox();
      select(null);
      if (active) render(false); // chrome + canvas mode follow the tool
    }),
  );
  agent.on('cms:edit-undo', agent.safe(() => active && undo()));
  agent.on('cms:edit-clear', agent.safe(() => active && clear()));

  agent.onTeardown(() => stop(false));
};
