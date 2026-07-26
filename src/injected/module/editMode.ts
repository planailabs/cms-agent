/**
 * Element-edit mode — armed via cms:edit-start; the user drags elements to
 * new positions (move tool), draws freehand strokes (draw tool), and drops
 * numbered comments (comment tool). Rendering goes through the shared
 * annotation renderer (../annotate.ts) so the live view matches the server's
 * handoff screenshot replay exactly.
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
  type AnnotatedElement,
  type EditAnnotations,
  type EditTool,
  type ElementMove,
} from '../annotate';
import type { AgentApi } from '../protocol';
import { cfg, onConfigChange } from './config';
import { cssPath, isOurs, type Listen } from './dom';
import { elementInfo } from './picker';

const TOOLS: EditTool[] = ['move', 'draw', 'comment'];
const MIN_DRAG_PX = 3;

type UndoEntry =
  | { kind: 'stroke' }
  | { kind: 'comment' }
  | { kind: 'move'; selector: string; prev: ElementMove | null };

export const initEditMode = (agent: AgentApi, listen: Listen): void => {
  let active = false;
  let tool: EditTool = 'move';
  let ann: EditAnnotations = emptyAnnotations();
  const undoStack: UndoEntry[] = [];

  let banner: HTMLDivElement | null = null;
  let hlBox: HTMLDivElement | null = null;
  let commentBox: HTMLDivElement | null = null;

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
    const existing = moveEntry(d.selector);
    undoStack.push({
      kind: 'move',
      selector: d.selector,
      prev: existing ? { ...existing } : null,
    });
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

  const closeCommentBox = (): void => {
    commentBox?.remove();
    commentBox = null;
  };

  const openCommentBox = (x: number, y: number, target: Element | null): void => {
    closeCommentBox();
    const box = document.createElement('div');
    box.className = `cms-ov-edit-input${cfg.theme === 'light' ? ' cms-ov-light' : ''}`;
    box.setAttribute('data-cms-overlay', '');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = cfg.labels.commentPlaceholder;
    input.maxLength = 2000;
    box.appendChild(input);
    box.style.left = `${Math.max(4, x)}px`;
    box.style.top = `${Math.max(4, y + 8)}px`;

    const commit = agent.safe(() => {
      const text = input.value.trim();
      closeCommentBox();
      if (!text) return;
      const n = ann.comments.reduce((max, c) => Math.max(max, c.n), 0) + 1;
      const comment: EditAnnotations['comments'][number] = { n, x, y, text };
      if (target && !isOurs(target)) {
        comment.selector = cssPath(target);
        comment.element = elementInfo(target) as unknown as AnnotatedElement;
      }
      ann.comments.push(comment);
      undoStack.push({ kind: 'comment' });
      render();
    });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') closeCommentBox();
    });
    // Keep page handlers away from clicks inside the box
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    box.addEventListener('click', (ev) => ev.stopPropagation());

    document.body.appendChild(box);
    commentBox = box;
    input.focus();
  };

  // ── Undo / clear ───────────────────────────────────────────────────────────

  const undo = (): void => {
    const entry = undoStack.pop();
    if (!entry) return;
    if (entry.kind === 'stroke') ann.strokes.pop();
    else if (entry.kind === 'comment') ann.comments.pop();
    else {
      const idx = ann.moves.findIndex((m) => m.selector === entry.selector);
      if (idx >= 0) {
        if (entry.prev) ann.moves[idx] = entry.prev;
        else ann.moves.splice(idx, 1);
      }
    }
    render();
  };

  const clear = (): void => {
    ann.moves = [];
    ann.strokes = [];
    ann.comments = [];
    undoStack.length = 0;
    render();
  };

  // ── Start / stop ───────────────────────────────────────────────────────────

  const stop = (notifyParent: boolean): void => {
    if (!active) return;
    active = false;
    drag = null;
    stroke = null;
    hideHl();
    closeCommentBox();
    banner?.remove();
    banner = null;
    clearAnnotations(document);
    if (notifyParent) agent.post({ type: 'cms:edit-stopped' });
  };

  const start = (data: Record<string, unknown>): void => {
    active = true;
    tool = TOOLS.includes(data.tool as EditTool) ? (data.tool as EditTool) : 'move';
    const prior = data.annotations as EditAnnotations | undefined;
    ann =
      prior && Array.isArray(prior.moves)
        ? { ...emptyAnnotations(), ...prior }
        : emptyAnnotations();
    ann.url = location.href;
    ann.route = location.pathname;
    undoStack.length = 0;
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
    if (commentBox) {
      commentBox.classList.toggle('cms-ov-light', cfg.theme === 'light');
      commentBox.querySelector('input')?.setAttribute('placeholder', cfg.labels.commentPlaceholder);
    }
  });

  // ── Pointer handlers (registered once; guarded on `active`) ────────────────

  const onPointerDown = agent.safe((ev: PointerEvent) => {
    if (!active) return;
    const target = ev.target as Element | null;
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
      ann.strokes.push({ points: s });
      undoStack.push({ kind: 'stroke' });
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
    if (tool === 'comment') openCommentBox(ev.pageX, ev.pageY, target);
  }) as EventListener;

  const onKey = agent.safe((ev: KeyboardEvent) => {
    if (!active || ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (commentBox) closeCommentBox();
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
      if (active) syncCanvasMode();
    }),
  );
  agent.on('cms:edit-undo', agent.safe(() => active && undo()));
  agent.on('cms:edit-clear', agent.safe(() => active && clear()));

  agent.onTeardown(() => stop(false));
};
