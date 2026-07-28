/**
 * Element-edit handoff — annotation schema bounds, the agent-facing summary,
 * and POST /api/chat/element-handoff (screenshot capture mocked; real
 * workflow transition + prisma + upload storage).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';

vi.mock('@/lib/diff/screenshot', () => ({
  captureAnnotatedRoute: vi.fn(async () => ({
    buffer: PNG.sync.write(new PNG({ width: 2, height: 2 })),
    status: 200,
  })),
}));
vi.mock('@/lib/agent/handler', () => ({ handleChatMessage: vi.fn(async () => {}) }));

import { prisma } from '@/lib/db';
import { captureAnnotatedRoute } from '@/lib/diff/screenshot';
import { handleChatMessage } from '@/lib/agent/handler';
import {
  annotationSummaryForAgent,
  editAnnotationsSchema,
} from '@/lib/handoff/elementEdit';
import type { EditAnnotations } from '@/injected/annotate';
import { POST } from '@/pages/api/chat/element-handoff';

const ACTOR = { id: 'el-handoff-user', name: 'Edit Tester', email: 'el-handoff@example.com' };

const annotations = (): EditAnnotations => ({
  url: 'https://c-x.example.com/about/',
  route: '/about/',
  viewport: { width: 1280, height: 900 },
  moves: [
    {
      selector: 'main > h1',
      element: { tag: 'h1', text: 'About' },
      dx: 40,
      dy: -12.4,
      rect: { x: 100, y: 200.6, w: 300, h: 48 },
    },
  ],
  strokes: [{ points: [[10, 20], [30, 44], [50, 40]] }],
  comments: [{ n: 1, x: 320, y: 260, text: 'Make this bigger' }],
});

const post = (body: unknown) =>
  POST({
    request: new Request('http://localhost/api/chat/element-handoff', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    locals: { user: { ...ACTOR, language: 'en' } },
  } as never);

let branchId: string;
const WORK_BRANCHES = ['c-elhand1', 'c-elhand2', 'c-elhand3', 'c-elhand4', 'c-elhand-wait'];

const makeChat = (workBranch: string, data: Record<string, unknown> = {}) =>
  prisma.chat.create({
    data: { branchId, workBranch, createdById: ACTOR.id, title: 'Handoff', ...data },
  });

beforeAll(async () => {
  await prisma.chat.deleteMany({ where: { workBranch: { in: WORK_BRANCHES } } });
  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  const u = await prisma.user.create({ data: ACTOR });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: u.id },
  });
  branchId = branch.id;
});

describe('annotation schema + summary', () => {
  it('accepts a well-formed set and enforces bounds', () => {
    expect(editAnnotationsSchema.safeParse(annotations()).success).toBe(true);
    const noSlash = { ...annotations(), route: 'about' };
    expect(editAnnotationsSchema.safeParse(noSlash).success).toBe(false);
    const fatStroke = {
      ...annotations(),
      strokes: [{ points: Array.from({ length: 501 }, (_, i) => [i, i] as [number, number]) }],
    };
    expect(editAnnotationsSchema.safeParse(fatStroke).success).toBe(false);
    const manyComments = {
      ...annotations(),
      comments: Array.from({ length: 51 }, (_, i) => ({ n: i + 1, x: 0, y: 0, text: 'x' })),
    };
    expect(editAnnotationsSchema.safeParse(manyComments).success).toBe(false);
  });

  it('reduces strokes to bounding boxes and keeps move/comment anchors', () => {
    const summary = annotationSummaryForAgent(annotations()) as {
      moves: Array<{ selector: string; from: object; moveBy: object }>;
      drawings: Array<{ bbox: object; points: number }>;
      comments: Array<{ n: number; text: string }>;
    };
    expect(summary.drawings).toEqual([{ bbox: { x: 10, y: 20, w: 40, h: 24 }, points: 3 }]);
    expect(summary.moves[0]).toMatchObject({
      selector: 'main > h1',
      from: { x: 100, y: 201, w: 300, h: 48 },
      moveBy: { dx: 40, dy: -12 },
    });
    expect(summary.comments[0]).toMatchObject({ n: 1, text: 'Make this bigger' });
  });

  it('swaps: schema accepts pairs (and their absence), summary passes them through', () => {
    const swap = {
      a: { selector: 'main > .hero', element: { tag: 'div' }, rect: { x: 0, y: 0, w: 600, h: 200 } },
      b: { selector: 'main > .cta', element: { tag: 'div' }, rect: { x: 0, y: 300, w: 600, h: 120 } },
    };
    expect(editAnnotationsSchema.safeParse(annotations()).success).toBe(true); // no swaps key
    const withSwap = { ...annotations(), swaps: [swap] };
    expect(editAnnotationsSchema.safeParse(withSwap).success).toBe(true);
    const summary = annotationSummaryForAgent(withSwap as never) as {
      swaps: Array<{ a: { selector: string }; b: { selector: string } }>;
    };
    expect(summary.swaps).toEqual([swap]);
  });
});

describe('POST /api/chat/element-handoff', () => {
  it('gates unknown, archived, published, and empty-annotation requests', async () => {
    expect((await post({ chatId: 'nope', annotations: annotations() })).status).toBe(404);

    const archived = await makeChat(WORK_BRANCHES[0], { archivedAt: new Date() });
    expect((await post({ chatId: archived.id, annotations: annotations() })).status).toBe(409);

    const published = await makeChat(WORK_BRANCHES[1], { workflowPhase: 'published' });
    const res = await post({ chatId: published.id, annotations: annotations() });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/published/);

    const empty = { ...annotations(), moves: [], strokes: [], comments: [] };
    const live = await makeChat(WORK_BRANCHES[2]);
    expect((await post({ chatId: live.id, annotations: empty })).status).toBe(400);
    expect(vi.mocked(captureAnnotatedRoute)).not.toHaveBeenCalled();
  });

  it('captures, stores the upload, flips execute → plan, and starts the turn', async () => {
    const chat = await makeChat(WORK_BRANCHES[3], { workflowPhase: 'execute' });
    const res = await post({ chatId: chat.id, note: 'header first', annotations: annotations() });
    expect(res.status).toBe(202);

    expect(vi.mocked(captureAnnotatedRoute)).toHaveBeenCalledWith(
      WORK_BRANCHES[3],
      '/about/',
      expect.objectContaining({ route: '/about/' }),
    );
    const after = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(after.workflowPhase).toBe('plan');

    const upload = await prisma.upload.findFirstOrThrow({ where: { chatId: chat.id } });
    expect(upload.mime).toBe('image/png');
    expect(upload.filename).toBe('element-edit-about.png');

    await vi.waitFor(() => expect(vi.mocked(handleChatMessage)).toHaveBeenCalled());
    const [, , msg] = vi.mocked(handleChatMessage).mock.calls.at(-1)!;
    expect(msg).toMatchObject({ chatId: chat.id, type: 'message', attachmentIds: [upload.id] });
    expect(msg.text).toContain('Note: header first');
    expect(msg.text).toContain(upload.id);
    expect(msg.text).toContain('propose_plan');
  });

  it('routes through the pending-answer path when the turn is paused', async () => {
    vi.mocked(handleChatMessage).mockClear();
    const chat = await makeChat('c-elhand-wait', {
      workflowPhase: 'execute',
      turnPhase: 'waiting_for_answer',
      pendingQuestion: { toolName: 'propose_plan', input: {} },
    });
    expect((await post({ chatId: chat.id, annotations: annotations() })).status).toBe(202);
    await vi.waitFor(() => expect(vi.mocked(handleChatMessage)).toHaveBeenCalled());
    const [, , msg] = vi.mocked(handleChatMessage).mock.calls.at(-1)!;
    expect(msg.type).toBe('answer');
    expect(msg.attachmentIds).toHaveLength(1);
    const after = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(after.workflowPhase).toBe('plan');
  });
});
