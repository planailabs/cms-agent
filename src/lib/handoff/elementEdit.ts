/**
 * Element-edit handoff — validation and agent-facing summary of the
 * annotation set the workspace collects in edit mode (src/injected/annotate.ts
 * is the client-side source of the shape).
 */
import { z } from 'zod';
import { strokeBbox, type EditAnnotations } from '@/injected/annotate';

const coord = z.number().finite().min(-1_000_000).max(1_000_000);

const elementSchema = z.object({
  tag: z.string().max(50),
  text: z.string().max(200).optional(),
  id: z.string().max(200).optional(),
  classes: z.array(z.string().max(100)).max(10).optional(),
  headingPath: z.array(z.string().max(200)).max(5).optional(),
  outerHtmlExcerpt: z.string().max(1000).optional(),
});

const rectSchema = z.object({ x: coord, y: coord, w: coord, h: coord });

/** Bounded mirror of EditAnnotations — rejects runaway payloads outright. */
export const editAnnotationsSchema = z.object({
  url: z.string().max(2000),
  route: z.string().min(1).max(500).startsWith('/'),
  viewport: z.object({
    width: z.number().int().min(0).max(10_000),
    height: z.number().int().min(0).max(10_000),
  }),
  moves: z
    .array(
      z.object({
        selector: z.string().min(1).max(1000),
        element: elementSchema,
        dx: coord,
        dy: coord,
        rect: rectSchema,
      }),
    )
    .max(50),
  swaps: z
    .array(
      z.object({
        a: z.object({ selector: z.string().min(1).max(1000), element: elementSchema, rect: rectSchema }),
        b: z.object({ selector: z.string().min(1).max(1000), element: elementSchema, rect: rectSchema }),
      }),
    )
    .max(50)
    .optional(),
  strokes: z
    .array(z.object({ points: z.array(z.tuple([coord, coord])).min(1).max(500) }))
    .max(100),
  comments: z
    .array(
      z.object({
        n: z.number().int().min(1).max(10_000),
        x: coord,
        y: coord,
        selector: z.string().max(1000).optional(),
        element: elementSchema.optional(),
        text: z.string().min(1).max(2000),
      }),
    )
    .max(50),
});

const round = Math.round;

/**
 * Compact JSON for the LLM: moves keep their anchors and deltas, strokes
 * reduce to bounding boxes (raw point lists are noise — the screenshot shows
 * the shape), comments keep the pin number that links them to the image.
 */
export const annotationSummaryForAgent = (a: EditAnnotations): Record<string, unknown> => ({
  route: a.route,
  viewport: a.viewport,
  moves: a.moves.map((m) => ({
    selector: m.selector,
    element: m.element,
    from: { x: round(m.rect.x), y: round(m.rect.y), w: round(m.rect.w), h: round(m.rect.h) },
    moveBy: { dx: round(m.dx), dy: round(m.dy) },
  })),
  swaps: (a.swaps ?? []).map((s) => ({
    a: { selector: s.a.selector, element: s.a.element, rect: s.a.rect },
    b: { selector: s.b.selector, element: s.b.element, rect: s.b.rect },
  })),
  drawings: a.strokes.map((s) => ({ bbox: strokeBbox(s), points: s.points.length })),
  comments: a.comments.map((c) => ({
    n: c.n,
    x: round(c.x),
    y: round(c.y),
    text: c.text,
    ...(c.selector ? { selector: c.selector } : {}),
    ...(c.element ? { element: c.element } : {}),
  })),
});

/** The user message that starts the agent's planning turn. */
export const handoffMessageText = (opts: {
  actorName: string;
  note: string;
  annotations: EditAnnotations;
  uploadId: string;
}): string => {
  const summary = JSON.stringify(annotationSummaryForAgent(opts.annotations));
  return (
    `Element-edit handoff from ${opts.actorName} on ${opts.annotations.route}.` +
    (opts.note ? `\nNote: ${opts.note}` : '') +
    `\nThe user annotated the live preview in element-edit mode. Annotation metadata (JSON):\n${summary}` +
    `\nAn annotated screenshot of the page is attached as upload ${opts.uploadId} — call read_upload with that id to view it: ` +
    `numbered pins = comments, red strokes = drawings, a dashed outline with an arrow = an element moved from its ghost (old position) to its new position, a teal double-headed arrow = two elements to swap with each other.` +
    `\nAnalyze the screenshot together with the metadata and call start_execution with a plan that implements the intended changes.`
  );
};
