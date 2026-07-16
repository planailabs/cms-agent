/**
 * Chat State Machine — transition(), sendChatMessage, answerChatQuestion,
 * cancelChatQuestion.
 */

import { store } from '../../app/store';
import { locales } from '../../content';
import { cacheAIChatMessages } from './cache';
import { connectEvents, postMessage } from './sse';

// ─────────────────────────────────────────────────────────────────────────────
// AI Chat State Machine
//
// Phases: idle → waiting → streaming → question → waiting → ...
//                                    → idle (done)
//         any  → error
//
// transition() is the single entry point for all phase changes. It cleans up
// the previous phase (cancels streaming, clears question/error) before
// entering the new one, which prevents stale UI from leaking across phases.
// ─────────────────────────────────────────────────────────────────────────────

/** Pending delayed transition from tool → waiting */
let toolTransitionTimer: ReturnType<typeof setTimeout> | null = null;
const TOOL_TRANSITION_DELAY_MS = 500;

/**
 * Transition to a new phase, cleaning up any state from the previous one.
 * Always call this instead of setting phase/fields directly.
 */
export const transition = (
  mc: NonNullable<typeof store.state.chat>['aiChat'],
  phase: 'idle' | 'waiting' | 'streaming' | 'tool' | 'question' | 'error',
) => {
  if (!mc) return;

  // Always cancel a pending tool→waiting transition
  if (toolTransitionTimer) {
    clearTimeout(toolTransitionTimer);
    toolTransitionTimer = null;
  }

  // Delay tool → waiting so the spinner shows for at least 500ms
  if (mc.phase === 'tool' && phase === 'waiting') {
    toolTransitionTimer = setTimeout(() => {
      toolTransitionTimer = null;
      const cur = store.state.chat?.aiChat;
      // Only transition if still in tool phase (another event may have moved us)
      if (cur?.phase === 'tool') {
        cur.phase = 'waiting';
        cur.toolName = undefined;
        store.notify();
      }
    }, TOOL_TRANSITION_DELAY_MS);
    return;
  }

  // tool → tool: new tool starting while still showing previous — just update name
  if (mc.phase === 'tool' && phase === 'tool') {
    return;
  }

  // Finalize any pending streaming text before leaving the phase
  if (mc.streamingText?.full) {
    mc.messages.push({ role: 'assistant', content: mc.streamingText.full });
    cacheAIChatMessages(mc.messages);
  }

  // Clear transient state from any previous phase
  mc.streamingText = undefined;
  mc.clientPrompt = undefined;
  mc.error = undefined;
  mc.toolName = undefined;

  mc.phase = phase;
};

// ─────────────────────────────────────────────────────────────────────────────
// Chat Message Sending
// ─────────────────────────────────────────────────────────────────────────────

export const sendChatMessage = async (message: string, pageContext?: string) => {
  const state = store.state;
  const mc = state.chat?.aiChat;
  if (!mc || !state.activeChatId) return;

  // If there's an active question, route as answer
  if (mc.phase === 'question') {
    answerChatQuestion(message);
    return;
  }

  transition(mc, 'waiting');
  mc.messages.push({ role: 'user', content: message });
  store.notify();

  // Ensure EventSource is connected before posting
  await connectEvents();

  // POST the message (with chatId) — events arrive via SSE
  void postMessage({ type: 'message', text: message, pageContext });
};

/**
 * Sends the user's answer to a pending question via POST.
 */
export const answerChatQuestion = async (text: string) => {
  const mc = store.state.chat?.aiChat;
  if (!mc) return;

  transition(mc, 'waiting');
  mc.messages.push({ role: 'user', content: text });
  cacheAIChatMessages(mc.messages);
  store.notify();

  await connectEvents();
  void postMessage({ type: 'answer', text });
};

export const cancelChatQuestion = async () => {
  const mc = store.state.chat?.aiChat;
  if (!mc || mc.phase !== 'question') return;

  const cancelLabel = locales[store.state.localeKey].chatMode.cancelLabel;
  transition(mc, 'waiting');
  mc.messages.push({ role: 'cancel', content: cancelLabel });
  cacheAIChatMessages(mc.messages);
  store.notify();

  await connectEvents();
  void postMessage({ type: 'answer', text: '__cancel__' });
};
