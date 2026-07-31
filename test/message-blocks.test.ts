/**
 * Display blocks — what a message shows, as opposed to what it says.
 *
 * The split matters in both directions: `content` is the text the model reads
 * on every turn, so it must not grow markup, and the transcript should show a
 * handoff as the thing it is (a page, some marks, three screenshots) rather
 * than as a paragraph naming upload ids.
 */
import { describe, expect, it } from 'vitest';
import {
  blockEnvelope,
  normalizeBlocks,
  uploadUrl,
  type DisplayBlock,
} from '@/lib/messageBlocks';
import { renderMessageBlocks } from '@/components/chat/ui/chat/blocks';
import { renderMessageBubbles } from '@/components/chat/ui/chat/bubbles';

const handoff: DisplayBlock = {
  kind: 'handoff',
  route: '/about/',
  note: 'header first',
  shots: [
    { uploadId: 'u-before', label: 'before' },
    { uploadId: 'u-edited', label: 'requested' },
    { uploadId: 'u-annotated', label: 'annotated' },
  ],
  counts: { moves: 1, swaps: 0, strokes: 0, comments: 2 },
};

describe('the storage envelope', () => {
  it('round-trips blocks', () => {
    expect(normalizeBlocks(blockEnvelope([handoff]))).toEqual([handoff]);
  });

  it('reads a legacy TranslatedMessage as a block', () => {
    // Every automatism and cancel row ever written holds the bare container.
    const tm = { i18n: 'chat.stopped', fallback: 'Stopped.' };
    expect(normalizeBlocks(tm)).toEqual([{ kind: 'tm', message: tm }]);
  });

  it('ignores shapes that are not display data', () => {
    // The same column holds tool calls and tool results for other roles.
    expect(normalizeBlocks([{ id: 'call_1', function: { name: 'read_file' } }])).toEqual([]);
    expect(normalizeBlocks(null)).toEqual([]);
    expect(normalizeBlocks('nonsense')).toEqual([]);
  });

  it('drops a kind it does not know instead of failing the transcript', () => {
    const mixed = { v: 1, blocks: [{ kind: 'from-the-future' }, handoff] };
    expect(normalizeBlocks(mixed)).toEqual([handoff]);
  });
});

describe('rendering', () => {
  it('shows the page, the note and every shot, each openable', () => {
    const html = renderMessageBlocks([handoff]);
    expect(html).toContain('/about/');
    expect(html).toContain('header first');
    for (const id of ['u-before', 'u-edited', 'u-annotated']) {
      // The URL lands in an attribute, so its & is escaped — that escaping is
      // the point, hence asserting the parts rather than the raw string.
      expect(html).toContain(`id=${id}`);
    }
    expect(html).toContain('mode=raw');
    expect(html.match(/data-action="msg-shot"/g)).toHaveLength(3);
  });

  it('summarizes what was drawn, leaving out what was not', () => {
    const html = renderMessageBlocks([handoff]);
    expect(html).toContain('1 moved');
    expect(html).toContain('2 comments');
    // Zero counts are noise in a one-line summary.
    expect(html).not.toContain('0 ');
  });

  it('escapes what the user typed', () => {
    const html = renderMessageBlocks([
      { ...handoff, note: '<script>alert(1)</script>' } as DisplayBlock,
    ]);
    expect(html).not.toContain('<script>');
  });

  it('renders nothing for a message with no blocks', () => {
    expect(renderMessageBlocks(undefined)).toBe('');
    expect(renderMessageBlocks([])).toBe('');
  });

  it('renders the generic kinds too', () => {
    const html = renderMessageBlocks([
      { kind: 'note', text: 'plain words' },
      { kind: 'facts', rows: [{ label: 'Branch', value: 'c-abc' }] },
      { kind: 'images', items: [{ uploadId: 'u-1', label: 'shot' }] },
    ]);
    expect(html).toContain('plain words');
    expect(html).toContain('Branch');
    expect(html).toContain('c-abc');
    expect(html).toContain('id=u-1');
    expect(uploadUrl('u-1')).toBe('/api/uploads?id=u-1&mode=raw');
  });
});

/**
 * One handoff is ONE message: the card, the attachment chips and the prose
 * were three rows saying the same thing, and the prose is agent-facing (upload
 * ids, annotation JSON) — the card is what replaces it for a human.
 */
describe('the message the card belongs to', () => {
  const message = {
    role: 'user' as const,
    content: 'Element-edit handoff from Dev Admin on /. Annotation metadata (JSON): {"route":"/"}',
    blocks: [handoff],
    attachments: [
      { id: 'u-before', filename: 'element-edit-home-before.png', mime: 'image/png' },
      { id: 'u-edited', filename: 'element-edit-home-edited.png', mime: 'image/png' },
      { id: 'u-annotated', filename: 'element-edit-home-annotated.png', mime: 'image/png' },
    ],
  };

  const render = (msg: unknown): string =>
    renderMessageBubbles({ phase: 'idle', messages: [msg] } as never);

  it('does not repeat the shots as attachment chips', () => {
    const html = render(message);
    expect(html).toContain('msg-card--handoff');
    expect(html).not.toContain('element-edit-home-before.png');
  });

  it('keeps the agent-facing prose, folded away', () => {
    const html = render(message);
    expect(html).toContain('msg-agent-text');
    expect(html).toContain('Annotation metadata');
  });

  it('leaves an ordinary message alone', () => {
    const html = render({
      role: 'user' as const,
      content: 'plain question',
      attachments: [{ id: 'u-9', filename: 'notes.md', mime: 'text/markdown' }],
    });
    expect(html).toContain('notes.md');
    expect(html).not.toContain('msg-agent-text');
    expect(html).toContain('plain question');
  });
});
