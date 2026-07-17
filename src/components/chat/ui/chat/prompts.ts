/**
 * Prompts — question UI rendering (ask_question tool).
 */

import { escapeHtml } from '../../utils/html';

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
        <div class="chat-attention__head">⚠ Needs human attention</div>
        ${input.reason ? `<p class="chat-attention__reason">${escapeHtml(input.reason)}</p>` : ''}
        ${input.instructions ? `<pre class="chat-attention__steps">${escapeHtml(input.instructions)}</pre>` : ''}
      </div>`;
    questionButtons = `<div class="flex flex-wrap gap-2 text-sm text-(--text-primary)">
        <button type="button" class="chat-cta-button" data-action="mc-question-choice" data-choice="Done">
          ✓ Done
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
