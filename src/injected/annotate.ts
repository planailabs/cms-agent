/**
 * Element-edit annotations — the data model and the DOM render primitives
 * shared by the live edit mode (src/injected/module/editMode.ts) and the
 * server-side screenshot replay (src/injected/annotateEntry.ts, evaluated in
 * a fresh Playwright page). One renderer, two consumers: what the user sees
 * while annotating is exactly what the agent gets in the handoff screenshot.
 *
 * All coordinates are DOCUMENT coordinates (client + scroll offset), so a
 * replay only needs the same viewport width to line up.
 */

/** Mirror of the element picker's info payload (picker.ts elementInfo). */
export interface AnnotatedElement {
  tag: string;
  text?: string;
  id?: string;
  classes?: string[];
  headingPath?: string[];
  outerHtmlExcerpt?: string;
}

export interface ElementMove {
  selector: string;
  element: AnnotatedElement;
  dx: number;
  dy: number;
  /** Original bounding rect in document coords. */
  rect: { x: number; y: number; w: number; h: number };
}

export interface Stroke {
  /** Freehand polyline, downsampled; document coords. */
  points: Array<[number, number]>;
}

export interface EditComment {
  /** 1-based pin number — the screenshot pin ↔ JSON comment link. */
  n: number;
  x: number;
  y: number;
  selector?: string;
  element?: AnnotatedElement;
  text: string;
}

export interface EditAnnotations {
  url: string;
  route: string;
  viewport: { width: number; height: number };
  moves: ElementMove[];
  strokes: Stroke[];
  comments: EditComment[];
}

export type EditTool = 'move' | 'draw' | 'comment';

export const emptyAnnotations = (url = '', route = '/'): EditAnnotations => ({
  url,
  route,
  viewport: { width: 0, height: 0 },
  moves: [],
  strokes: [],
  comments: [],
});

export const annotationCount = (a: EditAnnotations): number =>
  a.moves.length + a.strokes.length + a.comments.length;

/** Nodes created by the renderer (removed wholesale by clearAnnotations). */
const NODE_ATTR = 'data-cms-annotate';
/** Page elements the renderer styled in place (translate + outline reset). */
const MOVED_ATTR = 'data-cms-annotate-moved';

const ACCENT = '#e5484d'; // strokes + comment pins
const MOVE_ACCENT = '#7852ee'; // moved elements (matches the overlay accent)

const docSize = (doc: Document): { w: number; h: number } => {
  const el = doc.documentElement;
  const body = doc.body;
  return {
    w: Math.max(el.scrollWidth, body?.scrollWidth ?? 0, el.clientWidth),
    h: Math.max(el.scrollHeight, body?.scrollHeight ?? 0, el.clientHeight),
  };
};

/** Remove every annotation node and undo in-place element styling. */
export const clearAnnotations = (doc: Document): void => {
  for (const el of Array.from(doc.querySelectorAll(`[${NODE_ATTR}]`))) el.remove();
  for (const el of Array.from(doc.querySelectorAll(`[${MOVED_ATTR}]`))) {
    const html = el as HTMLElement;
    html.style.translate = '';
    html.style.outline = '';
    html.style.outlineOffset = '';
    el.removeAttribute(MOVED_ATTR);
  }
};

const annotationNode = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
): HTMLElementTagNameMap[K] => {
  const el = doc.createElement(tag);
  el.setAttribute(NODE_ATTR, '');
  // Counts as "ours" for the module's isOurs() checks (never pickable/draggable)
  el.setAttribute('data-cms-overlay', '');
  return el;
};

/** Document-sized drawing surface for strokes and move arrows. */
export const ensureOverlayCanvas = (doc: Document): HTMLCanvasElement => {
  let canvas = doc.querySelector<HTMLCanvasElement>(`canvas[${NODE_ATTR}]`);
  if (!canvas) {
    canvas = annotationNode(doc, 'canvas');
    canvas.style.cssText =
      'position:absolute;left:0;top:0;z-index:2147483643;pointer-events:none';
    (doc.body || doc.documentElement).appendChild(canvas);
  }
  const { w, h } = docSize(doc);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  return canvas;
};

export const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke): void => {
  if (stroke.points.length === 0) return;
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const [first, ...rest] = stroke.points;
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.arc(first[0], first[1], 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (const [x, y] of rest) ctx.lineTo(x, y);
  ctx.stroke();
};

const drawArrow = (
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void => {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 9;
  ctx.strokeStyle = MOVE_ACCENT;
  ctx.fillStyle = MOVE_ACCENT;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
  ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
};

/**
 * Ghost outline at the original position + translate/outline on the live
 * element (when the selector still resolves — a miss keeps the ghost, which
 * still communicates the intent).
 */
export const applyMove = (doc: Document, move: ElementMove): void => {
  const ghost = annotationNode(doc, 'div');
  ghost.style.cssText =
    `position:absolute;left:${move.rect.x}px;top:${move.rect.y}px;` +
    `width:${move.rect.w}px;height:${move.rect.h}px;` +
    `border:2px dashed ${MOVE_ACCENT};border-radius:2px;opacity:.6;` +
    'z-index:2147483642;pointer-events:none';
  (doc.body || doc.documentElement).appendChild(ghost);

  let el: Element | null = null;
  try {
    el = doc.querySelector(move.selector);
  } catch {
    /* invalid selector — ghost only */
  }
  if (el instanceof HTMLElement) {
    el.style.translate = `${move.dx}px ${move.dy}px`;
    el.style.outline = `2px dashed ${MOVE_ACCENT}`;
    el.style.outlineOffset = '-1px';
    el.setAttribute(MOVED_ATTR, '');
  }
};

export const renderPin = (doc: Document, comment: EditComment): void => {
  const pin = annotationNode(doc, 'div');
  pin.textContent = String(comment.n);
  pin.title = comment.text;
  pin.style.cssText =
    `position:absolute;left:${comment.x - 11}px;top:${comment.y - 11}px;` +
    `width:22px;height:22px;border-radius:50%;background:${ACCENT};` +
    'color:#fff;font:700 12px/22px system-ui,sans-serif;text-align:center;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:2147483644;pointer-events:none';
  (doc.body || doc.documentElement).appendChild(pin);
};

/** Full render: clear, then moves (ghost+translate), strokes+arrows, pins. */
export const applyAnnotations = (doc: Document, a: EditAnnotations): void => {
  clearAnnotations(doc);
  for (const move of a.moves) applyMove(doc, move);
  const canvas = ensureOverlayCanvas(doc);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of a.strokes) drawStroke(ctx, stroke);
    for (const move of a.moves) {
      const cx = move.rect.x + move.rect.w / 2;
      const cy = move.rect.y + move.rect.h / 2;
      drawArrow(ctx, cx, cy, cx + move.dx, cy + move.dy);
    }
  }
  for (const comment of a.comments) renderPin(doc, comment);
};
