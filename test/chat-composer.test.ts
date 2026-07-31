import { describe, expect, it } from 'vitest';
import { renderChatComposer } from '@/components/chat/ui/chat/composer';
import { locales } from '@/components/chat/content';

describe('chat composer', () => {
  it('replaces message input with Resume for an ownerless pending turn', () => {
    const html = renderChatComposer(
      { phase: 'idle', messages: [], canContinue: true },
      locales.en,
      locales.en.chatMode,
    );

    expect(html).toContain('composer-card--resume');
    expect(html).toContain('data-action="chat-continue"');
    expect(html).not.toContain('data-action="machine-config-input"');
  });

  // There is nothing to type into while the loop runs, so the composer's slot
  // is where the way out of it belongs.
  it.each(['waiting', 'streaming', 'tool', 'compacting'] as const)(
    'offers Stop during the %s phase',
    (phase) => {
      const html = renderChatComposer({ phase, messages: [] }, locales.en, locales.en.chatMode);
      expect(html).toContain('data-action="chat-stop"');
      expect(html).not.toContain('data-action="machine-config-input"');
      expect(html).not.toContain('disabled');
    },
  );

  it('disables Stop once one was sent, so a second click cannot re-fire it', () => {
    const html = renderChatComposer(
      { phase: 'tool', messages: [], stopping: true },
      locales.en,
      locales.en.chatMode,
    );
    expect(html).toContain('data-action="chat-stop"');
    expect(html).toContain('disabled');
  });

  it('gives the input back when the turn is over', () => {
    const html = renderChatComposer({ phase: 'idle', messages: [] }, locales.en, locales.en.chatMode);
    expect(html).toContain('data-action="machine-config-input"');
    expect(html).not.toContain('data-action="chat-stop"');
  });
});
