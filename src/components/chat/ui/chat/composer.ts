/**
 * Composer — chat input field and hero header.
 */

import { escapeHtml } from '../../utils/html';
import { SEND_ICON_SVG } from '../icons';

import type { LocaleContent, ChatModeLocale } from '../../content';
import type { ChatState } from '../../app/state';

type AiChat = NonNullable<ChatState['aiChat']>;

// ── Chat Composer (input field) ─────────────────────────────────────────

export const renderChatComposer = (
  mc: AiChat,
  locale: LocaleContent,
  modeLocale: ChatModeLocale,
): string => {
  const prompt = mc.phase === 'question' ? mc.clientPrompt : undefined;
  const skipLabel = escapeHtml(modeLocale.cancelLabel);

  const aqInput = prompt?.toolName === 'ask_question' ? prompt.input as { type?: string; question?: string } : undefined;
  const isTextQuestion = mc.phase === 'question' && aqInput?.type === 'text';
  // A dismissed workflow card ("Not yet — keep chatting") re-opens the
  // composer; the next message is routed as the answer to the pending tool.
  const isDismissedCard = mc.phase === 'question' && prompt?.dismissed === true;
  const showComposer = mc.phase === 'idle' || mc.phase === 'error' || isTextQuestion || isDismissedCard;

  const placeholder = escapeHtml(
    isTextQuestion ? (aqInput!.question ?? modeLocale.placeholder) : modeLocale.placeholder,
  );

  return showComposer
    ? `<div class="composer-card" data-form="machine-config-composer">
          <div class="composer-wrapper">
            ${isTextQuestion
              ? `<button
                  type="button"
                  class="composer-skip-button"
                  data-action="mc-question-cancel"
                >${skipLabel}</button>`
              : ''}
            <div
              class="composer-input"
              role="textbox"
              contenteditable="plaintext-only"
              aria-label="${placeholder}"
              data-empty="true"
              inputmode="text"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="sentences"
              data-action="machine-config-input"></div>
            <button
              type="button"
              class="composer-send-button"
              data-action="machine-config-send"
              aria-label="${escapeHtml(locale.composer.submitLabel)}"
              aria-disabled="true" disabled>
              ${SEND_ICON_SVG}
            </button>
          </div>
        </div>`
    : '';
};

// ── Hero Header ─────────────────────────────────────────────────────────

export const renderHeroHeader = (
  mc: AiChat,
  modeLocale: ChatModeLocale,
): string => {
  const isEmptyState = mc.messages.length === 0;
  return `<div class="space-y-3 text-center md:space-y-4">
        <p class="text-[0.65rem] uppercase tracking-[0.35em] text-(--text-muted) md:text-xs md:tracking-[0.4em]">
          ${escapeHtml(modeLocale.heroBadgeLabel)}
        </p>
        <h1 class="${isEmptyState ? 'text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl' : 'text-xl font-semibold tracking-tight sm:text-2xl md:text-3xl'}">
          ${escapeHtml(modeLocale.heading)}
        </h1>
      </div>`;
};
