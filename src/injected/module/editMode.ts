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
  snapAnchorsFromRects,
  snapDelta,
  strokeBbox,
  type AnnotatedElement,
  type AnnotationSelection,
  type EditAnnotations,
  type EditTool,
  type ElementMove,
  type Rect,
  type SnapAnchors,
} from '../annotate';
import type { AgentApi } from '../protocol';
import { createHelpBanner, type HelpBanner } from './banner';
import { cfg, onConfigChange } from './config';
import { cssPath, isOurs, type Listen } from './dom';
import { elementInfo } from './picker';

const TOOLS: EditTool[] = ['cursor', 'move', 'swap', 'draw', 'comment'];
const MIN_DRAG_PX = 3;

export const initEditMode = (agent: AgentApi, listen: Listen): void => {
  let active = false;
  let tool: EditTool = 'cursor';
  let ann: EditAnnotations = emptyAnnotations();
  /** Snapshot undo stack — one deep copy per mutation. */
  const history: EditAnnotations[] = [];
  const redoHistory: Array<{ annotations: EditAnnotations; history: EditAnnotations[] }> = [];

  let banner: HelpBanner | null = null;
  let hlBox: HTMLDivElement | null = null;

  const snapshot = (): void => {
    redoHistory.length = 0;
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

  const deleteAt = (sel: AnnotationSelection): void => {
    snapshot();
    removeAnnotation(ann, sel);
    hideBubble();
    render();
  };

  /** 🗑 button that deletes the given annotation (indices are regenerated on
   *  every render, so the captured selection stays valid until then).
   *  Clamped to the document on all sides — callers place it past the
   *  annotation's right edge, which lands offscreen for full-width elements. */
  const makeBin = (x: number, y: number, sel: AnnotationSelection): HTMLButtonElement => {
    const BIN = 26;
    const doc = document.documentElement;
    const maxX = Math.max(doc.scrollWidth, doc.clientWidth) - BIN - 4;
    const maxY = Math.max(doc.scrollHeight, doc.clientHeight) - BIN - 4;
    const b = chromeNode('button', 'cms-ov-bin');
    b.type = 'button';
    b.textContent = '🗑';
    b.style.left = `${Math.min(Math.max(4, x), maxX)}px`;
    b.style.top = `${Math.min(Math.max(4, y), maxY)}px`;
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

  const makeEdit = (x: number, y: number, index: number): HTMLButtonElement => {
    const SIZE = 26;
    const doc = document.documentElement;
    const b = chromeNode('button', 'cms-ov-bin cms-ov-edit');
    b.type = 'button';
    b.textContent = '✎';
    b.title = cfg.labels.editComment;
    b.setAttribute('aria-label', cfg.labels.editComment);
    b.style.left = `${Math.min(Math.max(4, x), Math.max(doc.scrollWidth, doc.clientWidth) - SIZE - 4)}px`;
    b.style.top = `${Math.min(Math.max(4, y), Math.max(doc.scrollHeight, doc.clientHeight) - SIZE - 4)}px`;
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    b.addEventListener(
      'click',
      agent.safe((ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
        const comment = ann.comments[index];
        if (comment) openCommentBox(comment.x, comment.y, null, index);
      }) as EventListener,
    );
    document.body.appendChild(b);
    return b;
  };

  const makeRing = (
    x: number,
    y: number,
    w: number,
    h: number,
    extraClass = '',
  ): HTMLDivElement => {
    const r = chromeNode('div', `cms-ov-ring${extraClass ? ` ${extraClass}` : ''}`);
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    r.style.width = `${w}px`;
    r.style.height = `${h}px`;
    document.body.appendChild(r);
    return r;
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
      allChrome.push(
        bub,
        makeBin(c.x + 16, c.y - 30, { kind: 'comment', index: i }),
        makeEdit(c.x + 46, c.y - 30, i),
      );
    });
    ann.strokes.forEach((s, i) => {
      const box = strokeBbox(s);
      allChrome.push(
        makeRing(box.x - 6, box.y - 6, box.w + 12, box.h + 12),
        makeBin(box.x + box.w + 8, box.y - 30, { kind: 'stroke', index: i }),
      );
    });
    ann.moves.forEach((m, i) => {
      // The red ring stays visible on moves — the dashed outline alone is
      // easy to miss next to a floating 🗑.
      allChrome.push(
        makeRing(m.rect.x + m.dx - 4, m.rect.y + m.dy - 4, m.rect.w + 8, m.rect.h + 8),
        makeBin(m.rect.x + m.dx + m.rect.w + 8, m.rect.y + m.dy - 30, { kind: 'move', index: i }),
      );
    });
    (ann.swaps ?? []).forEach((sw, i) => {
      allChrome.push(
        makeRing(sw.a.rect.x - 4, sw.a.rect.y - 4, sw.a.rect.w + 8, sw.a.rect.h + 8),
        makeRing(sw.b.rect.x - 4, sw.b.rect.y - 4, sw.b.rect.w + 8, sw.b.rect.h + 8),
        makeBin(sw.a.rect.x + sw.a.rect.w + 8, sw.a.rect.y - 30, { kind: 'swap', index: i }),
      );
    });
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
    if (tool === 'cursor') showAllChrome();
    else hideAllChrome();
    if (post) {
      agent.post({ type: 'cms:edit-changed', annotations: ann, undoDepth: history.length, canRedo: redoHistory.length > 0 });
    }
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
    /** Original (untranslated) doc rect — snap edges are computed from it. */
    rect: Rect;
    /** Alignment axes of parent/siblings + the original position. */
    anchors: SnapAnchors;
    /** Last applied (snapped) translate — what pointerup commits. */
    snapDx: number;
    snapDy: number;
  }
  let drag: Drag | null = null;

  // ── Alignment guides (Google-Drawings-style snap lines) ────────────────────

  let guideV: HTMLDivElement | null = null;
  let guideH: HTMLDivElement | null = null;
  const guideLine = (vertical: boolean): HTMLDivElement => {
    const g = chromeNode('div', 'cms-ov-guide');
    const doc = document.documentElement;
    g.style.cssText =
      'position:absolute;z-index:2147483645;pointer-events:none;background:#7852ee;' +
      (vertical
        ? `top:0;width:1px;height:${Math.max(doc.scrollHeight, doc.clientHeight)}px`
        : `left:0;height:1px;width:${Math.max(doc.scrollWidth, doc.clientWidth)}px`);
    document.body.appendChild(g);
    return g;
  };
  const showGuides = (x: number | null, y: number | null): void => {
    if (x !== null) {
      guideV ??= guideLine(true);
      guideV.style.left = `${x}px`;
      guideV.style.display = '';
    } else if (guideV) guideV.style.display = 'none';
    if (y !== null) {
      guideH ??= guideLine(false);
      guideH.style.top = `${y}px`;
      guideH.style.display = '';
    } else if (guideH) guideH.style.display = 'none';
  };
  const hideGuides = (): void => {
    guideV?.remove();
    guideH?.remove();
    guideV = null;
    guideH = null;
  };

  /** Doc rects worth aligning to: the element's original spot, its parent
   *  and visible siblings. */
  const collectAnchors = (el: HTMLElement, original: Rect): SnapAnchors => {
    const rects: Rect[] = [original];
    const parent = el.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      const pr = parent.getBoundingClientRect();
      rects.push({ x: pr.left + window.scrollX, y: pr.top + window.scrollY, w: pr.width, h: pr.height });
    }
    for (const sib of Array.from(parent?.children ?? [])) {
      if (sib === el || isOurs(sib) || rects.length >= 40) continue;
      const r = sib.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      rects.push({ x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height });
    }
    return snapAnchorsFromRects(rects);
  };

  const moveEntry = (selector: string): ElementMove | undefined =>
    ann.moves.find((m) => m.selector === selector);

  const commitMove = (d: Drag, dx: number, dy: number): void => {
    snapshot();
    const existing = moveEntry(d.selector);
    if (existing) {
      existing.dx = dx;
      existing.dy = dy;
    } else {
      ann.moves.push({
        selector: d.selector,
        element: elementInfo(d.el) as unknown as AnnotatedElement,
        dx,
        dy,
        // Original rect, captured at drag start (before any live translate)
        rect: d.rect,
      });
    }
    render();
  };

  // ── Swap tool (drag element A onto element B → exchange them) ──────────────

  interface SwapDrag {
    el: HTMLElement;
    selector: string;
    rect: Rect;
    moved: boolean;
  }
  let swapDrag: SwapDrag | null = null;

  const endpointOf = (el: HTMLElement): { selector: string; element: AnnotatedElement; rect: Rect } => {
    const r = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      element: elementInfo(el) as unknown as AnnotatedElement,
      rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
    };
  };

  const cancelSwapDrag = (): void => {
    if (!swapDrag) return;
    swapDrag.el.style.outline = '';
    swapDrag.el.style.outlineOffset = '';
    swapDrag = null;
    hideHl();
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
    submit: HTMLButtonElement;
    index?: number;
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
    const { x, y, target, input, index } = pending;
    const text = input.value.trim();
    closeCommentBox();
    if (!text) return;
    snapshot();
    if (index !== undefined) {
      ann.comments[index].text = text;
      render();
      return;
    }
    const n = ann.comments.length + 1;
    const comment: EditAnnotations['comments'][number] = { n, x, y, text };
    if (target && !isOurs(target)) {
      comment.selector = cssPath(target);
      comment.element = elementInfo(target) as unknown as AnnotatedElement;
    }
    ann.comments.push(comment);
    render();
  }) as () => void;

  const openCommentBox = (x: number, y: number, target: Element | null, index?: number): void => {
    closeCommentBox();
    const box = chromeNode('div', `cms-ov-edit-input${cfg.theme === 'light' ? ' cms-ov-light' : ''}`);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = cfg.labels.commentPlaceholder;
    input.maxLength = 2000;
    input.value = index === undefined ? '' : ann.comments[index]?.text ?? '';
    box.appendChild(input);
    const submit = chromeNode('button', 'cms-ov-icon-btn');
    submit.type = 'button';
    submit.title = cfg.labels.submitComment;
    submit.setAttribute('aria-label', cfg.labels.submitComment);
    submit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/></svg>';
    submit.addEventListener('click', commitPendingComment);
    box.appendChild(submit);
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
    pending = { x, y, target, box, input, submit, index };
    input.focus();
  };

  // ── Undo / clear ───────────────────────────────────────────────────────────

  const undo = (): void => {
    if (history.length > 0) {
      redoHistory.push({
        annotations: JSON.parse(JSON.stringify(ann)) as EditAnnotations,
        history: history.map((entry) => JSON.parse(JSON.stringify(entry)) as EditAnnotations),
      });
    }
    const prev = history.pop();
    if (!prev) return;
    ann = prev;
    hideBubble();
    render();
  };

  const clear = (): void => {
    redoHistory.push({
      annotations: JSON.parse(JSON.stringify(ann)) as EditAnnotations,
      history: history.map((entry) => JSON.parse(JSON.stringify(entry)) as EditAnnotations),
    });
    ann.moves = [];
    ann.strokes = [];
    ann.comments = [];
    history.length = 0;
    hideBubble();
    render();
  };

  const redo = (): void => {
    const next = redoHistory.pop();
    if (!next) return;
    ann = next.annotations;
    history.splice(0, history.length, ...next.history);
    hideBubble();
    render();
  };

  // ── Start / stop ───────────────────────────────────────────────────────────

  const stop = (notifyParent: boolean): void => {
    if (!active) return;
    active = false;
    drag = null;
    cancelSwapDrag();
    stroke = null;
    hideGuides();
    hideHl();
    hideBubble();
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
    redoHistory.length = 0;
    banner?.remove();
    banner = createHelpBanner('edit', cfg.labels.editInstruction);
    render(false);
  };

  onConfigChange(() => {
    banner?.setText(cfg.labels.editInstruction);
    if (pending) {
      pending.box.classList.toggle('cms-ov-light', cfg.theme === 'light');
      pending.input.placeholder = cfg.labels.commentPlaceholder;
      pending.submit.title = cfg.labels.submitComment;
      pending.submit.setAttribute('aria-label', cfg.labels.submitComment);
    }
    if (active && tool === 'cursor') showAllChrome();
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
      // Annotation boundaries never block a drag — deletion/selection is
      // cursor mode's job. The hit-test is only used for re-drag dedupe.
      const hit = hitTestAnnotations(ann, ev.pageX, ev.pageY);
      let el = target;
      let selector = cssPath(target);
      let existing = moveEntry(selector);
      if (!existing && hit?.kind === 'move') {
        // Grabbed inside an already-moved element (often via a child node,
        // which has its own selector) — re-drag the existing move instead of
        // recording a second one for the child.
        const m = ann.moves[hit.index];
        let resolved: Element | null = null;
        try {
          resolved = document.querySelector(m.selector);
        } catch {
          /* keep the event target */
        }
        if (resolved instanceof HTMLElement) {
          el = resolved;
          selector = m.selector;
          existing = m;
        }
      }
      const baseDx = existing?.dx ?? 0;
      const baseDy = existing?.dy ?? 0;
      const r = el.getBoundingClientRect();
      const rect: Rect = {
        x: r.left + window.scrollX - baseDx,
        y: r.top + window.scrollY - baseDy,
        w: r.width,
        h: r.height,
      };
      drag = {
        el,
        selector,
        baseDx,
        baseDy,
        startX: ev.pageX,
        startY: ev.pageY,
        moved: false,
        rect,
        anchors: collectAnchors(el, rect),
        snapDx: baseDx,
        snapDy: baseDy,
      };
    }
    if (tool === 'swap' && target instanceof HTMLElement) {
      const r = target.getBoundingClientRect();
      swapDrag = {
        el: target,
        selector: cssPath(target),
        rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
        moved: false,
      };
      target.style.outline = '2px dashed #12a594';
      target.style.outlineOffset = '-1px';
    }
  }) as EventListener;

  const onPointerMove = agent.safe((ev: PointerEvent) => {
    if (!active) return;
    if (drag) {
      const dx = ev.pageX - drag.startX;
      const dy = ev.pageY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) >= MIN_DRAG_PX) drag.moved = true;
      if (drag.moved) {
        const snapped = snapDelta(drag.rect, drag.baseDx + dx, drag.baseDy + dy, drag.anchors);
        drag.snapDx = snapped.dx;
        drag.snapDy = snapped.dy;
        drag.el.style.translate = `${snapped.dx}px ${snapped.dy}px`;
        showGuides(snapped.guideX, snapped.guideY);
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
      else hideBubble();
    }
    // Swap drag: highlight the drop target under the pointer
    if (swapDrag) {
      swapDrag.moved = true;
      const over = ev.target as Element | null;
      if (over && over.nodeType === 1 && !isOurs(over) && over !== swapDrag.el) showHl(over);
      else hideHl();
      return;
    }
    // Hover highlight for tools that act on a page element.
    if (tool !== 'move' && tool !== 'swap' && tool !== 'comment') return;
    const el = ev.target as Element | null;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    showHl(el);
  }) as EventListener;

  const onPointerUp = agent.safe((ev: PointerEvent) => {
    if (!active) return;
    if (drag) {
      const d = drag;
      drag = null;
      hideGuides();
      if (d.moved) commitMove(d, d.snapDx, d.snapDy);
      return;
    }
    if (swapDrag) {
      const sd = swapDrag;
      const over = ev.target as Element | null;
      cancelSwapDrag();
      if (
        sd.moved &&
        over instanceof HTMLElement &&
        !isOurs(over) &&
        over !== sd.el &&
        !sd.el.contains(over) &&
        !over.contains(sd.el)
      ) {
        snapshot();
        ann.swaps ??= [];
        ann.swaps.push({
          a: { selector: sd.selector, element: elementInfo(sd.el) as unknown as AnnotatedElement, rect: sd.rect },
          b: endpointOf(over),
        });
        render();
      }
      return;
    }
    if (stroke) {
      const s = stroke;
      stroke = null;
      if (s.length < 2) return; // a click, not a stroke
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
    // Annotation boundaries never swallow clicks here — comments must be
    // placeable anywhere; deletion lives in cursor mode.
    if (tool === 'comment') openCommentBox(ev.pageX, ev.pageY, target);
  }) as EventListener;

  const onKey = agent.safe((ev: KeyboardEvent) => {
    if (!active || ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (pending) closeCommentBox();
    else stop(true);
  }) as EventListener;

  // Reflow moves the doc edges the bin clamp depends on — reposition chrome.
  listen(
    window,
    'resize',
    agent.safe(() => {
      if (active && tool === 'cursor') showAllChrome();
    }) as EventListener,
  );

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
      hideGuides();
      hideHl();
      hideBubble();
      closeCommentBox();
      if (active) render(false); // chrome + canvas mode follow the tool
    }),
  );
  agent.on('cms:edit-undo', agent.safe(() => active && undo()));
  agent.on('cms:edit-clear', agent.safe(() => active && clear()));
  agent.on('cms:edit-redo', agent.safe(() => active && redo()));

  agent.onTeardown(() => stop(false));
};
