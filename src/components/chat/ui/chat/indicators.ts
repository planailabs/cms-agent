/**
 * Phase Indicators — streaming bubble, thinking dots, tool spinner, error message.
 */

import { escapeHtml } from '../../utils/html';
import { renderMarkdown } from '../../utils/markdown';

import type { ChatModeLocale } from '../../content';
import type { ChatState } from '../../app/state';

type AiChat = NonNullable<ChatState['aiChat']>;

export const renderStreamingBubble = (mc: AiChat): string =>
  mc.phase === 'streaming' && mc.streamingText
    ? `<div class="flex justify-start">
          <div class="chat-markdown chat-markdown--streaming max-w-full text-sm leading-relaxed text-(--text-primary)">
            ${renderMarkdown(mc.streamingText.visible)}
          </div>
        </div>`
    : '';

export const renderThinkingIndicator = (mc: AiChat): string =>
  mc.phase === 'waiting'
    ? `<div class="flex justify-start">
          <div class="max-w-full text-sm leading-relaxed text-(--text-muted)">
            <span class="inline-flex gap-1">
              <span class="inline-block h-2 w-2 rounded-full bg-(--text-muted) animate-bounce" style="animation-delay: 0ms"></span>
              <span class="inline-block h-2 w-2 rounded-full bg-(--text-muted) animate-bounce" style="animation-delay: 150ms"></span>
              <span class="inline-block h-2 w-2 rounded-full bg-(--text-muted) animate-bounce" style="animation-delay: 300ms"></span>
            </span>
          </div>
        </div>`
    : '';

export const renderToolIndicator = (
  mc: AiChat,
  modeLocale: ChatModeLocale,
): string =>
  mc.phase === 'tool'
    ? `<div class="flex justify-start">
          <div class="max-w-full flex items-center gap-2 text-xs text-(--text-muted)">
            <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-(--text-muted) border-t-transparent"></span>
            ${escapeHtml(modeLocale.configuringLabel)}
          </div>
        </div>`
    : '';

export const renderErrorMessage = (mc: AiChat): string =>
  mc.phase === 'error' && mc.error
    ? `<div class="flex flex-col items-start gap-2">
          <p class="max-w-full text-sm leading-relaxed text-red-500">
            ${escapeHtml(mc.error)}
          </p>
          <button type="button" class="ws-mini-button" data-action="chat-continue">
            ↻ Retry
          </button>
        </div>`
    : '';

/** Interrupted turn (e.g. server restart) — offer to continue where it stopped. */
export const renderContinuePrompt = (mc: AiChat): string =>
  mc.canContinue && mc.phase === 'idle'
    ? `<div class="flex flex-col items-start gap-2">
          <p class="max-w-full text-sm leading-relaxed text-amber-500">
            This session was interrupted before the last turn finished.
          </p>
          <button type="button" class="ws-mini-button" data-action="chat-continue">
            ▶ Continue
          </button>
        </div>`
    : '';
