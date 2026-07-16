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

// ── Empty state (sidebar first-run view, before any message) ────────────

export const renderEmptyState = (
  mc: AiChat,
  modeLocale: ChatModeLocale,
): string => {
  if (mc.messages.length > 0) return '';

  const chips = modeLocale.examplePrompts
    .map(
      (prompt) => `<button
          type="button"
          class="chat-example-chip"
          data-action="chat-example-prompt"
          data-prompt="${escapeHtml(prompt)}"
        >${escapeHtml(prompt)}</button>`,
    )
    .join('');

  return `<div class="chat-empty-state">
        <span class="chat-empty-state__glyph" aria-hidden="true">✦</span>
        <h2 class="text-sm font-semibold tracking-tight text-(--text-primary)">
          ${escapeHtml(modeLocale.heading)}
        </h2>
        <p class="text-xs leading-relaxed text-(--text-muted)">
          ${escapeHtml(modeLocale.emptyHint)}
        </p>
        ${chips ? `<div class="chat-empty-state__chips">${chips}</div>` : ''}
      </div>`;
};
