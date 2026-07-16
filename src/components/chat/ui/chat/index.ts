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
import { renderStreamingBubble, renderThinkingIndicator, renderToolIndicator, renderErrorMessage } from './indicators';
import { renderQuestionUI } from './prompts';
import { renderChatComposer, renderHeroHeader } from './composer';
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
    'max-w-[min(100%,640px)]',
    'rounded-3xl',
    'bg-(--surface-elevated)',
    'px-5',
    'py-3',
    'text-base',
    'text-(--text-primary)',
  ];
  if (state.chat.userBubbleJustAppeared) {
    userBubbleClasses.push('just-entered');
  }
  const assistantBubbleClasses = [
    'bubble-animate',
    'max-w-[min(100%,640px)]',
    'text-base',
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
    const heroHeader = renderHeroHeader(mc, modeLocale);

    const isEmptyState = mc.messages.length === 0;
    const sectionClasses = isEmptyState
      ? 'flex w-full max-w-3xl flex-col gap-4 text-center md:gap-6'
      : 'flex w-full max-w-3xl flex-col gap-8 text-left';

    return `
      <section class="${sectionClasses}">
        ${heroHeader}
        ${messageBubbles}
        ${streamingBubble}
        ${thinkingIndicator}
        ${toolIndicator}
        ${errorMessage}
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
    <section class="flex w-full max-w-3xl flex-col gap-8 text-left">
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
