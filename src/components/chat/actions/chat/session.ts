/**
 * Chat Session — restoreAIChatSession, fetchAIChatHistory, initAIChat,
 * ChatHistoryResult.
 */

import { store } from '../../app/store';
import { locales } from '../../content';
import {
  cacheAIChatMessages,
  readCachedAIChatMessages,
  type StoredMessage,
} from './cache';
import { connectEvents } from './sse';
import { sendChatMessage } from './stateMachine';

export interface ChatHistoryResult {
  messages: StoredMessage[];
  phase?: string;
  pendingQuestion?: Record<string, unknown>;
}

export const initAIChat = (messages: StoredMessage[], phase: 'idle' | 'waiting' = 'idle') => {
  const state = store.state;
  state.chat = {
    userPrompt: messages[0]?.content ?? '',
    assistantVisibleText: '',
    assistantFullText: '',
    stream: { initialDelayMs: 0, chunkSize: 1, intervalMs: 0 },
    isStreaming: false,
    aiChat: {
      messages,
      phase,
    },
  };
  store.notify();
};

/**
 * Fetches chat history from the server and populates the sessionStorage cache.
 * Returns messages, phase, and pendingQuestion (if waiting_for_answer).
 */
export const fetchAIChatHistory = async (chatId?: string): Promise<ChatHistoryResult | null> => {
  try {
    const id = chatId ?? store.state.activeChatId;
    if (!id) return null;

    const response = await fetch(`/api/chat/history?chatId=${encodeURIComponent(id)}`);
    if (!response.ok) return null;

    const data = await response.json();
    const messages = (data.messages ?? []) as StoredMessage[];
    if (messages.length > 0) {
      cacheAIChatMessages(messages, id);
    }
    return {
      messages,
      phase: data.phase,
      pendingQuestion: data.pendingQuestion,
    };
  } catch {
    // Network error — fall through
  }
  return null;
};

/**
 * Restores the active chat session (page load or chat switch).
 * - Shows cached messages instantly (sessionStorage)
 * - Fetches authoritative history from server
 */
export const restoreAIChatSession = (): void => {
  const state = store.state;
  const chatId = state.activeChatId;
  if (!chatId) return;

  // Don't re-init if already active
  if (state.chat?.aiChat) return;

  // Instant restore from sessionStorage cache (show immediately while server loads)
  const cached = readCachedAIChatMessages(chatId);
  if (cached && cached.length > 0) {
    initAIChat(cached);
  } else {
    initAIChat([]);
    store.notify();
  }

  // Pre-connect EventSource eagerly
  void connectEvents();

  // Fetch authoritative history from server — then decide whether to auto-send greeting
  const applyHistory = (result: ChatHistoryResult | null) => {
    const mc = store.state.chat?.aiChat;
    if (!mc || store.state.activeChatId !== chatId) return;

    if (result && result.messages.length > 0) {
      const cancelLabel = locales[store.state.localeKey].chatMode.cancelLabel;
      mc.messages = result.messages.map((m) =>
        m.role === 'cancel' ? { ...m, content: m.content || cancelLabel } : m,
      );
      store.state.chat!.userPrompt = result.messages[0]?.content ?? '';

      // Restore pending question if server is waiting for an answer
      if (result.phase === 'waiting_for_answer' && result.pendingQuestion) {
        mc.phase = 'question';
        // Backwards compat: old format has { type, question, options }, new has { toolName, input }
        const pq = result.pendingQuestion;
        if (pq.toolName) {
          mc.clientPrompt = { toolName: pq.toolName as string, input: (pq.input ?? {}) as Record<string, unknown> };
        } else {
          mc.clientPrompt = { toolName: 'ask_question', input: pq };
        }
      } else {
        mc.phase = 'idle';
      }

      store.notify();
    } else {
      // Server has no history — auto-send greeting if configured
      const locale = locales[store.state.localeKey];
      const greeting = locale.chatMode.greeting;
      if (greeting) {
        void sendChatMessage(greeting);
      }
    }
  };

  void fetchAIChatHistory(chatId).then(applyHistory);
};
