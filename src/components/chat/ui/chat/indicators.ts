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
          <div class="chat-markdown chat-markdown--streaming max-w-[min(100%,640px)] text-base leading-relaxed text-(--text-primary)">
            ${renderMarkdown(mc.streamingText.visible)}
          </div>
        </div>`
    : '';

export const renderThinkingIndicator = (mc: AiChat): string =>
  mc.phase === 'waiting'
    ? `<div class="flex justify-start">
          <div class="max-w-[min(100%,640px)] text-base leading-relaxed text-(--text-muted)">
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
          <div class="max-w-[min(100%,640px)] flex items-center gap-2 text-xs text-(--text-muted)">
            <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-(--text-muted) border-t-transparent"></span>
            ${escapeHtml(modeLocale.configuringLabel)}
          </div>
        </div>`
    : '';

export const renderErrorMessage = (mc: AiChat): string =>
  mc.phase === 'error' && mc.error
    ? `<div class="flex justify-start">
          <p class="max-w-[min(100%,640px)] text-base leading-relaxed text-red-500">
            ${escapeHtml(mc.error)}
          </p>
        </div>`
    : '';
