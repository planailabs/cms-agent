import { describe, expect, it, vi, beforeEach } from 'vitest';
import { streamingController } from './streaming';
import { createInitialState } from '../app/state';
import { locales } from '../content';
import { store } from '../app/store';

const locale = locales.en;

describe('text-streaming animation controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset store before each test
    store.state = createInitialState();
  });

  it('initializes chat bubbles and schedules reset', () => {
    const render = vi.fn();
    vi.spyOn(store, 'subscribe').mockImplementation((fn) => {
      render.mockImplementation(fn);
      return () => {};
    });

    // Mock notify to call render
    vi.spyOn(store, 'notify').mockImplementation(() => {
      render();
    });

    streamingController.startChatFromPrompt('Test prompt', locale, {
      enableBubbleAnimation: true,
    });

    const state = store.state;
    expect(state.chat).toBeTruthy();
    expect(state.chat?.userBubbleJustAppeared).toBe(true);
    expect(state.chat?.assistantBubbleJustAppeared).toBe(true);

    streamingController.scheduleBubbleAnimationReset();
    vi.runAllTimers();

    expect(state.chat?.userBubbleJustAppeared).toBe(false);
    expect(state.chat?.assistantBubbleJustAppeared).toBe(false);
  });

  it('skips streaming when requested', () => {
    const render = vi.fn();
    vi.spyOn(store, 'notify').mockImplementation(render);

    streamingController.startChatFromPrompt('Cached prompt', locale, {
      skipStreaming: true,
      enableBubbleAnimation: false,
    });

    const state = store.state;
    expect(state.chat?.assistantVisibleText).toBe(
      state.chat?.assistantFullText,
    );
    expect(state.chat?.isStreaming).toBe(false);
  });

  it('stores provided conversation pointer', () => {
    const render = vi.fn();
    vi.spyOn(store, 'notify').mockImplementation(render);

    const pointer = {
      scenarioId: 'greeting',
      stepId: 'intro',
    };

    streamingController.startChatFromPrompt('Pointer prompt', locale, {
      conversationPointer: pointer,
    });

    expect(store.state.chat?.conversation).toEqual(pointer);
  });
});
