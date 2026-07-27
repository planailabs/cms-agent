import { describe, expect, it } from 'vitest';
import { renderMessageBubbles } from '@/components/chat/ui/chat/bubbles';
import type { ChatState } from '@/components/chat/app/state';

type AiChat = NonNullable<ChatState['aiChat']>;
type Msg = AiChat['messages'][number];

const tool = (name: string, opts: { running?: boolean; result?: string } = {}): Msg =>
  ({
    role: 'tool',
    content: '',
    tool: { name, input: { arg: 1 }, running: opts.running ?? false, result: opts.result },
  }) as unknown as Msg;

const assistant = (content: string): Msg => ({ role: 'assistant', content }) as unknown as Msg;

const mc = (messages: Msg[]): AiChat => ({ messages }) as unknown as AiChat;

const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

describe('collapsed tool-call groups', () => {
  it('groups consecutive tool calls into one collapsible block', () => {
    const html = renderMessageBubbles(
      mc([tool('read_content'), tool('write_markdown'), assistant('done'), tool('build_site')]),
      [],
      true,
    );
    expect(count(html, /class="chat-tools"/g)).toBe(2);
    expect(count(html, /chat-tools__row/g)).toBe(3);
    expect(html).toContain('2 tool calls');
    expect(html).toContain('1 tool call');
  });

  it('marks a group with a running call open and pulsing', () => {
    const html = renderMessageBubbles(mc([tool('build_site', { running: true })]), [], true);
    expect(html).toContain('<details class="chat-tools" open');
    expect(html).toContain('is-running');
  });

  it('shows a truncated first result line as the row meta', () => {
    const long = `${'x'.repeat(60)}\nsecond line`;
    const html = renderMessageBubbles(mc([tool('run', { result: long })]), [], true);
    expect(html).toContain(`${'x'.repeat(47)}…`);
    expect(html).not.toContain('second line</span>');
  });

  it('hides tool calls entirely in non-technical mode', () => {
    const html = renderMessageBubbles(mc([tool('read_content'), assistant('hi')]), [], false);
    expect(html).not.toContain('chat-tools');
  });
});
