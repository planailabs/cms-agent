/**
 * Prompts — question UI rendering (ask_question tool).
 */

import { escapeHtml } from '../../utils/html';
import { t, uiLocale } from '@/lib/i18n';

import type { ChatModeLocale } from '../../content';
import type { ChatState } from '../../app/state';

type AiChat = NonNullable<ChatState['aiChat']>;

// ── Question UI (ask_question) ──────────────────────────────────────────

export const renderQuestionUI = (
  mc: AiChat,
  modeLocale: ChatModeLocale,
): { questionLabel: string; questionButtons: string } => {
  const prompt = mc.phase === 'question' ? mc.clientPrompt : undefined;
  const skipLabel = escapeHtml(modeLocale.cancelLabel);

  let questionLabel = '';
  let questionButtons = '';
  if (prompt?.toolName === 'needs_human_attention') {
    const input = prompt.input as { reason?: string; instructions?: string };
    questionLabel = `<div class="chat-attention">
        <div class="chat-attention__head">⚠ ${escapeHtml(t(uiLocale(), 'chat.attention.head'))}</div>
        ${input.reason ? `<p class="chat-attention__reason">${escapeHtml(input.reason)}</p>` : ''}
        ${input.instructions ? `<pre class="chat-attention__steps">${escapeHtml(input.instructions)}</pre>` : ''}
      </div>`;
    questionButtons = `<div class="flex flex-wrap gap-2 text-sm text-(--text-primary)">
        <button type="button" class="chat-cta-button" data-action="mc-question-choice" data-choice="Done">
          ✓ ${escapeHtml(t(uiLocale(), 'chat.attention.done'))}
        </button>
        <button type="button" class="chat-cta-button chat-cta-button--cancel" data-action="mc-question-cancel">
          ${skipLabel}
        </button>
      </div>`;
  } else if (prompt?.toolName === 'pick_color') {
    const input = prompt.input as { question?: string; current?: string };
    const start = /^#[0-9a-fA-F]{6}$/.test(input.current ?? '') ? input.current! : '#7852ee';
    if (input.question) {
      questionLabel = `<div class="flex justify-start">
          <p class="max-w-full text-sm leading-relaxed text-(--text-muted)">
            ${escapeHtml(input.question)}
          </p>
        </div>`;
    }
    questionButtons = `<div class="flex flex-wrap items-center gap-2 text-sm text-(--text-primary)">
        <input type="color" class="chat-color-input" data-action="mc-color-input"
          value="${escapeHtml(start)}" aria-label="${escapeHtml(t(uiLocale(), 'chat.color.pick'))}" />
        <button type="button" class="chat-cta-button" data-action="mc-color-confirm">
          ✓ ${escapeHtml(t(uiLocale(), 'chat.color.confirm'))}
        </button>
        <button type="button" class="chat-cta-button chat-cta-button--cancel" data-action="mc-question-cancel">
          ${skipLabel}
        </button>
      </div>`;
  } else if (prompt?.toolName === 'ask_question') {
    const aqInput = prompt.input as { type?: string; question?: string; options?: string[] };
    if (aqInput.question) {
      questionLabel = `<div class="flex justify-start">
          <p class="max-w-full text-sm leading-relaxed text-(--text-muted)">
            ${escapeHtml(aqInput.question)}
          </p>
        </div>`;
    }
    if (aqInput.type === 'multiple_choice' && aqInput.options) {
      questionButtons = `<div class="flex flex-wrap gap-2 text-sm text-(--text-primary)">
            ${aqInput.options
              .map(
                (opt) => `
              <button
                type="button"
                class="chat-cta-button"
                data-action="mc-question-choice"
                data-choice="${escapeHtml(opt)}"
              >
                ${escapeHtml(opt)}
              </button>`,
              )
              .join('')}
            <button type="button" class="chat-cta-button chat-cta-button--cancel" data-action="mc-question-cancel">
              ${skipLabel}
            </button>
          </div>`;
    }
  }
  return { questionLabel, questionButtons };
};
