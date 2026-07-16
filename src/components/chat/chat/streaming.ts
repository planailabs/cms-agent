import { store } from '../app/store';
import type { LocaleContent, StreamConfig } from '../content';
import { startCharacterStream } from '../utils/stream';

type TimeoutId = ReturnType<typeof setTimeout> | null;

/** Pointer into a scripted conversation (scenario/step ids) */
export interface ConversationPointer {
  scenarioId: string;
  stepId: string;
}

export interface StartPromptOptions {
  skipStreaming?: boolean;
  enableBubbleAnimation?: boolean;
  onStreamComplete?: () => void;
  responseOverride?: {
    text: string;
    stream: StreamConfig;
  };
  conversationPointer?: ConversationPointer | null;
}

let streamDelayTimeout: TimeoutId = null;
let streamCancel: (() => void) | null = null;
let streamCompleteCallback: (() => void) | null = null;

const runStreamCompleteCallback = () => {
  if (streamCompleteCallback) {
    const callback = streamCompleteCallback;
    streamCompleteCallback = null;
    callback();
  }
};

const startAssistantStream = () => {
  const state = store.state;
  if (!state.chat) {
    return;
  }
  const { assistantFullText, stream } = state.chat;
  const totalLength = assistantFullText.length;

  if (streamDelayTimeout) {
    clearTimeout(streamDelayTimeout);
    streamDelayTimeout = null;
  }
  if (streamCancel) {
    streamCancel();
    streamCancel = null;
  }

  const run = () => {
    if (!state.chat) {
      return;
    }

    streamCancel = startCharacterStream(
      totalLength,
      state.chat.stream.chunkSize,
      state.chat.stream.intervalMs,
      (index) => {
        if (!state.chat) return;
        state.chat.assistantVisibleText = assistantFullText.slice(0, index);
        store.notify();
      },
      () => {
        streamCancel = null;
        if (!state.chat) return;

        state.chat.isStreaming = false;
        store.notify();
        runStreamCompleteCallback();
      },
    );
  };

  streamDelayTimeout = setTimeout(run, stream.initialDelayMs);
};

const startChatFromPrompt = (
  prompt: string,
  locale: LocaleContent,
  options?: StartPromptOptions,
) => {
  const state = store.state;
  const animateBubbles = options?.enableBubbleAnimation ?? true;
  const response = options?.responseOverride ?? locale.chat.intro;
  streamCompleteCallback = options?.onStreamComplete ?? null;
  state.chat = {
    userPrompt: prompt,
    assistantVisibleText: '',
    assistantFullText: response.text,
    stream: response.stream,
    isStreaming: true,
    userBubbleJustAppeared: animateBubbles,
    assistantBubbleJustAppeared: animateBubbles,
    conversation: options?.conversationPointer ?? undefined,
  };
  store.notify();

  if (!options?.skipStreaming) {
    startAssistantStream();
  } else if (state.chat) {
    state.chat.assistantVisibleText = state.chat.assistantFullText;
    state.chat.isStreaming = false;
    runStreamCompleteCallback();
  }
};

const scheduleBubbleAnimationReset = () => {
  const state = store.state;
  if (!state.chat) {
    return;
  }
  const hasPendingAnimation =
    state.chat.userBubbleJustAppeared ||
    state.chat.assistantBubbleJustAppeared;
  if (!hasPendingAnimation) {
    return;
  }
  setTimeout(() => {
    if (!state.chat) {
      return;
    }
    const raf =
      typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (cb: FrameRequestCallback) => setTimeout(cb, 0);
    raf(() => {
      if (!state.chat) {
        return;
      }
      state.chat.userBubbleJustAppeared = false;
      state.chat.assistantBubbleJustAppeared = false;
    });
  }, 0);
};

export const streamingController = {
  startChatFromPrompt,
  scheduleBubbleAnimationReset,
};
