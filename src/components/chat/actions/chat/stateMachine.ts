/**
 * Chat State Machine — transition(), sendChatMessage, answerChatQuestion,
 * cancelChatQuestion.
 */

import { store } from '../../app/store';
import { locales } from '../../content';
import { t, uiLocale } from '@/lib/i18n';
import { cacheAIChatMessages, type AttachmentDisplay } from './cache';
import { connectEvents, postMessage } from './sse';
import type { PageContext } from '../../../workspace/state';

/**
 * Turn the open draft into a real chat: create the row (the server adopts a
 * pre-warmed work branch and starts its preview), then point the session at
 * it WITHOUT switchChat — that would drop the message being sent.
 */
const materializeDraftChat = async (): Promise<boolean> => {
  const state = store.state;
  if (!state.activeBranchId) return false;
  const { createChat } = await import('./index');
  const chat = await createChat(state.activeBranchId);
  if (!chat) {
    const mc = state.chat?.aiChat;
    if (mc) {
      mc.error = t(uiLocale(), 'workspace.error.chatCreateFailed');
      mc.phase = 'error';
      store.notify();
    }
    return false;
  }
  state.activeChatId = chat.id;
  state.activeChatKind = chat.kind ?? 'workflow';
  state.activeChatTitle = chat.title;
  state.workflowPhase = chat.workflowPhase ?? 'plan';
  store.notify(); // mirrors the URL to /chat/<id>
  return true;
};

/**
 * Detaches the pending workspace context chip (if any) so its anchor is
 * sent as pageContext with the outgoing message.
 */
const takeContextChip = (): PageContext | undefined => {
  const ws = store.state.workspace;
  if (!ws.contextChip) return undefined;
  const context = ws.contextChip.context;
  ws.contextChip = null;
  return context;
};

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
  phase: 'idle' | 'waiting' | 'streaming' | 'tool' | 'compacting' | 'question' | 'error',
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

export const sendChatMessage = async (
  message: string,
  pageContext?: PageContext,
  attachments?: AttachmentDisplay[],
) => {
  const state = store.state;
  const mc = state.chat?.aiChat;
  if (!mc) return;

  // If there's an active question, route as answer (carrying attachments)
  if (mc.phase === 'question') {
    answerChatQuestion(message, attachments);
    return;
  }

  // Draft chat (new-chat / fresh window): the Chat row is created by the
  // first message, which also starts its worktree and preview server.
  if (!state.activeChatId) {
    if (!(await materializeDraftChat())) return;
  }

  // Attach the pending context chip (selection/element from the preview)
  pageContext = pageContext ?? takeContextChip();

  transition(mc, 'waiting');
  mc.messages.push({
    role: 'user',
    content: message,
    ...(attachments?.length ? { attachments } : {}),
  });
  store.notify();

  // Ensure EventSource is connected before posting
  await connectEvents();

  // POST the message (with chatId + attachment ids) — events arrive via SSE
  void postMessage({
    type: 'message',
    text: message,
    pageContext,
    attachmentIds: attachments?.map((a) => a.id).filter((id): id is string => !!id),
  });
};

/**
 * Sends the user's answer to a pending question via POST.
 */
export const answerChatQuestion = async (text: string, attachments?: AttachmentDisplay[]) => {
  const mc = store.state.chat?.aiChat;
  if (!mc) return;

  const pageContext = takeContextChip();

  transition(mc, 'waiting');
  mc.messages.push({
    role: 'user',
    content: text,
    ...(attachments?.length ? { attachments } : {}),
  });
  cacheAIChatMessages(mc.messages);
  store.notify();

  await connectEvents();
  void postMessage({
    type: 'answer',
    text,
    pageContext,
    attachmentIds: attachments?.map((a) => a.id).filter((id): id is string => !!id),
  });
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
