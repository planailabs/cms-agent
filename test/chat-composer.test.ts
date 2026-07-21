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
});
