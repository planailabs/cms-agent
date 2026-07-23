/**
 * Composer — chat input field and hero header.
 */

import { escapeHtml } from '../../utils/html';
import { SEND_ICON_SVG } from '../icons';
import { t, uiLocale } from '@/lib/i18n';
import { store } from '../../app/store';
import {
  ATTACHMENT_ACCEPT,
  composerHasContent,
  renderAttachmentChipsHtml,
} from '../../actions/chat/attachments';

import type { LocaleContent, ChatModeLocale } from '../../content';
import type { ChatState } from '../../app/state';

type AiChat = NonNullable<ChatState['aiChat']>;

// ── Chat Composer (input field) ─────────────────────────────────────────

export const renderChatComposer = (
  mc: AiChat,
  locale: LocaleContent,
  modeLocale: ChatModeLocale,
): string => {
  if (mc.canContinue && mc.phase === 'idle') {
    return `<div class="composer-card composer-card--resume" data-form="machine-config-composer">
          <div class="composer-resume-copy">
            ${escapeHtml(t(uiLocale(), 'chat.continue.interrupted'))}
          </div>
          <button type="button" class="composer-resume-button" data-action="chat-continue">
            <span aria-hidden="true">▶</span>
            ${escapeHtml(t(uiLocale(), 'chat.continue.button'))}
          </button>
        </div>`;
  }

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

  const multiple = store.state.attachmentsOnePerMessage ? '' : ' multiple';
  const attachLabel = escapeHtml(t(uiLocale(), 'chat.attach.add'));
  // Attachments live in the module, not the store — seed from there so a full
  // re-render reflects staged files; live updates patch the container in place.
  const sendDisabled = composerHasContent('') ? '' : ' aria-disabled="true" disabled';

  return showComposer
    ? `<div class="composer-card" data-form="machine-config-composer" data-action="chat-dropzone">
          <div class="composer-chips" data-attach-chips>${renderAttachmentChipsHtml()}</div>
          <div class="composer-wrapper">
            ${isTextQuestion
              ? `<button
                  type="button"
                  class="composer-skip-button"
                  data-action="mc-question-cancel"
                >${skipLabel}</button>`
              : ''}
            <button
              type="button"
              class="composer-attach-button"
              data-action="chat-attach"
              aria-label="${attachLabel}"
              title="${attachLabel}">📎</button>
            <input
              type="file"
              class="composer-attach-input"
              data-action="chat-attach-input"
              accept="${ATTACHMENT_ACCEPT}"${multiple}
              hidden />
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
              aria-label="${escapeHtml(locale.composer.submitLabel)}"${sendDisabled}>
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
