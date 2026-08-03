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

  // A dismissed workflow card gives the composer its slot back — and keeps it.
  // The card's own `dismissed` flag does not survive a chat-state snapshot
  // (they replace clientPrompt wholesale), so the composer asks the workspace
  // slice, which nothing replaces. Before that, opening the compare window
  // was enough to put the card back over a composer mid-sentence.
  it('keeps the input while a workflow card is dismissed', async () => {
    const { store } = await import('@/components/chat/app/store');
    const { createInitialWorkspaceState } = await import('@/components/workspace/state');
    const { renderWorkflowCards } = await import('@/components/chat/ui/chat/cards');
    const mc = {
      phase: 'question' as const,
      messages: [],
      clientPrompt: { toolName: 'finish_execution', input: { summary: 'done' } },
    };
    store.state.activeChatId = 'chat-1';
    store.state.workspace = createInitialWorkspaceState();

    // Card up, composer replaced by its action row.
    expect(renderChatComposer(mc, locales.en, locales.en.chatMode)).not.toContain(
      'data-action="machine-config-input"',
    );
    expect(renderWorkflowCards({ ...store.state, chat: { aiChat: mc } } as never)).toContain(
      'data-card="execution-finished"',
    );

    // "Not yet — keep chatting", recorded where a snapshot cannot undo it.
    store.state.workspace.dismissedPrompt = { chatId: 'chat-1', toolName: 'finish_execution' };
    expect(renderChatComposer(mc, locales.en, locales.en.chatMode)).toContain(
      'data-action="machine-config-input"',
    );
    expect(renderWorkflowCards({ ...store.state, chat: { aiChat: mc } } as never)).not.toContain(
      'data-card="execution-finished"',
    );
  });
});
