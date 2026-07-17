/**
 * Chat Section Component
 *
 * Renders the chat conversation view with:
 * - Message bubbles (user / assistant / cancel)
 * - Streaming, thinking, tool, and error indicators
 * - Question UI (ask_question tool)
 * - Composer input
 */

import type { LocaleContent } from '../../content';
import type { AppState } from '../../app/state';
import { escapeHtml } from '../../utils/html';

import { renderMessageBubbles } from './bubbles';
import { renderStreamingBubble, renderThinkingIndicator, renderToolIndicator, renderErrorMessage, renderContinuePrompt } from './indicators';
import { renderQuestionUI } from './prompts';
import { renderChatComposer, renderEmptyState } from './composer';
import { renderWorkflowCards, renderContextChip } from './cards';

export const renderChatSection = (
  locale: LocaleContent,
  state: AppState,
): string => {
  if (!state.chat) {
    return '';
  }
  const { userPrompt, assistantVisibleText, isStreaming } = state.chat;
  const userBubbleClasses = [
    'bubble-animate',
    'max-w-[85%]',
    'rounded-2xl',
    'bg-(--surface-elevated)',
    'px-3.5',
    'py-2',
    'text-sm',
    'text-(--text-primary)',
  ];
  if (state.chat.userBubbleJustAppeared) {
    userBubbleClasses.push('just-entered');
  }
  const assistantBubbleClasses = [
    'bubble-animate',
    'max-w-full',
    'text-sm',
    'leading-relaxed',
    'text-(--text-primary)',
  ];
  if (state.chat.assistantBubbleJustAppeared) {
    assistantBubbleClasses.push('just-entered');
  }
  const streamingIndicator = isStreaming
    ? '<span class="ml-1 inline-block h-4 w-1.5 rounded-full bg-(--text-muted) animate-pulse"></span>'
    : '';

  // ─── AI Chat Mode ─────────────────────────────────────────────────────
  const mc = state.chat.aiChat;
  if (mc) {
    const modeLocale = locale.chatMode;

    const messageBubbles = renderMessageBubbles(mc);
    const streamingBubble = renderStreamingBubble(mc);
    const thinkingIndicator = renderThinkingIndicator(mc);
    const toolIndicator = renderToolIndicator(mc, modeLocale);
    const errorMessage = renderErrorMessage(mc);
    const { questionLabel, questionButtons } = renderQuestionUI(mc, modeLocale);
    const workflowCards = renderWorkflowCards(state);
    const contextChip = renderContextChip(state);
    const inputField = renderChatComposer(mc, locale, modeLocale);
    const emptyState = renderEmptyState(mc, modeLocale);

    return `
      <section class="chat-section flex w-full flex-col gap-4 text-left">
        ${emptyState}
        ${messageBubbles}
        ${streamingBubble}
        ${thinkingIndicator}
        ${toolIndicator}
        ${errorMessage}
        ${renderContinuePrompt(mc)}
        ${workflowCards}
        ${questionLabel}
        ${questionButtons}
        ${contextChip}
        ${inputField}
      </section>
    `;
  }

  // ─── Scripted-stream fallback (used by streamingController) ──────────
  return `
    <section class="chat-section flex w-full flex-col gap-4 text-left">
      <div class="flex justify-end">
        <p class="${userBubbleClasses.join(' ')}">
          ${escapeHtml(userPrompt)}
        </p>
      </div>
      <div class="flex justify-start">
        <p class="${assistantBubbleClasses.join(' ')}">
          ${escapeHtml(assistantVisibleText)}${streamingIndicator}
        </p>
      </div>
    </section>
  `;
};
