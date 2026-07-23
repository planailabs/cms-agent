import { describe, expect, it } from 'vitest';
import { toOpenAiMessages, type ImageResolver } from '@/lib/agent/messageUtils';
import type { StoredMessage, ToolCall } from '@/lib/agent/types';

const readUploadCall = (id: string, uploadId: string): ToolCall =>
  ({
    id,
    type: 'function',
    function: { name: 'read_upload', arguments: JSON.stringify({ uploadId }) },
  }) as ToolCall;

const resolver: ImageResolver = (uploadId) =>
  uploadId === 'u1' ? { mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' } : null;

describe('attachment message conversion', () => {
  it('appends an [Attachments] manifest as plain string content (no image parts)', () => {
    const msgs: StoredMessage[] = [
      {
        role: 'user',
        content: 'have a look',
        attachments: [{ id: 'u1', mime: 'image/png', filename: 'shot.png' }],
      },
    ];
    const [msg] = toOpenAiMessages(msgs, resolver);
    expect(msg.role).toBe('user');
    expect(typeof msg.content).toBe('string');
    expect(msg.content).toContain('[Attachments]');
    expect(msg.content).toContain('u1');
    expect(msg.content).toContain('shot.png');
  });

  it('injects a multimodal user message after an image read_upload result', () => {
    const msgs: StoredMessage[] = [
      { role: 'user', content: 'look', attachments: [{ id: 'u1', mime: 'image/png', filename: 'a.png' }] },
      { role: 'assistant', content: '', toolCalls: [readUploadCall('call_1', 'u1')] },
      { role: 'tool', results: [{ toolCallId: 'call_1', content: '{"image":true,"uploadId":"u1"}' }] },
    ];
    const out = toOpenAiMessages(msgs, resolver);

    // The tool result stays a text tool message...
    const toolMsg = out.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(typeof (toolMsg as { content: unknown }).content).toBe('string');

    // ...followed by a synthetic user message carrying the image.
    const toolIdx = out.indexOf(toolMsg!);
    const injected = out[toolIdx + 1];
    expect(injected.role).toBe('user');
    expect(Array.isArray(injected.content)).toBe(true);
    const parts = injected.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url.startsWith('data:image/png'))).toBe(true);
  });

  it('does not inject anything without a resolver, and text results stay plain', () => {
    const msgs: StoredMessage[] = [
      { role: 'assistant', content: '', toolCalls: [readUploadCall('call_1', 'u1')] },
      { role: 'tool', results: [{ toolCallId: 'call_1', content: 'plain text' }] },
    ];
    const out = toOpenAiMessages(msgs); // no resolver
    expect(out.filter((m) => m.role === 'user')).toHaveLength(0);
    expect(out.every((m) => typeof m.content === 'string' || m.content === null)).toBe(true);
  });

  it('leaves attachment-free user messages unchanged', () => {
    const [msg] = toOpenAiMessages([{ role: 'user', content: 'hello' }], resolver);
    expect(msg.content).toBe('hello');
  });
});
