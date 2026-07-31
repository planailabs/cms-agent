/**
 * Composer — chat input field and hero header.
 */

import { escapeHtml } from '../../utils/html';
import { commandMenuHtml } from './commands';
import { SEND_ICON_SVG } from '../icons';
import { t, uiLocale } from '@/lib/i18n';
import { store } from '../../app/store';
import {
  ATTACHMENT_ACCEPT,
  composerHasContent,
  renderAttachmentChipsHtml,
} from '../../actions/chat/attachments';

import type { LocaleContent, ChatModeLocale } from '../../content';
import type { AppState, ChatState } from '../../app/state';

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

  // While the loop runs there is nothing to type into — the composer is
  // replaced by the way out of it.
  if (mc.phase === 'waiting' || mc.phase === 'streaming' || mc.phase === 'tool' || mc.phase === 'compacting') {
    const label = t(uiLocale(), mc.stopping ? 'chat.stop.stopping' : 'chat.stop.button');
    return `<div class="composer-card composer-card--resume" data-form="machine-config-composer">
          <div class="composer-resume-copy">
            ${escapeHtml(t(uiLocale(), 'chat.stop.running'))}
          </div>
          <button type="button" class="composer-resume-button" data-action="chat-stop"
            ${mc.stopping ? 'aria-disabled="true" disabled' : ''}>
            <span aria-hidden="true">■</span>
            ${escapeHtml(label)}
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
  const pickLabel = escapeHtml(t(uiLocale(), 'workspace.preview.pickTitle'));
  // Attachments live in the module, not the store — seed from there so a full
  // re-render reflects staged files; live updates patch the container in place.
  const sendDisabled = composerHasContent('') ? '' : ' aria-disabled="true" disabled';

  return showComposer
    ? `<div class="composer-card" data-form="machine-config-composer" data-action="chat-dropzone">
          ${commandMenuHtml()}
          <div class="composer-chips" data-attach-chips>${renderAttachmentChipsHtml()}</div>
          <div class="composer-command" data-command-chip></div>
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
            <button
              type="button"
              class="composer-attach-button composer-pick-button ${store.state.workspace.pickerActive ? 'is-active' : ''}"
              data-action="ws-element-pick"
              aria-label="${pickLabel}"
              title="${pickLabel}">⌖</button>
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

// ── Review action row (below the composer, EXECUTE phase) ───────────────

/** Publish / request-changes verdicts for the reviewed draft — they live
 *  here (single place, mockup layout) instead of the phase bar/diff header.
 *  Reviewing is part of EXECUTE, so the row rides along from the first
 *  commit; publish stays disabled until there is a sha to bind. */
export const renderChatActionRow = (state: AppState): string => {
  if (
    state.activeChatKind !== 'workflow' ||
    state.workflowPhase !== 'execute' ||
    !state.activeChatId ||
    state.activeChatArchived
  ) {
    return '';
  }
  const locale = uiLocale();
  const publishing = state.workspace.publish?.status === 'running';
  const hasSha = Boolean(state.workspace.executionSha);
  return `<div class="chat-actions-row">
      <button type="button" class="ws-mini-button ws-mini-button--primary chat-actions-row__publish"
        data-action="ws-publish" ${!hasSha || publishing ? 'disabled' : ''}
        title="${hasSha ? escapeHtml(t(locale, 'workspace.phase.publishSha', { sha: state.workspace.executionSha!.slice(0, 8) })) : escapeHtml(t(locale, 'workspace.phase.waitingForCommit'))}">
        ${escapeHtml(t(locale, publishing ? 'workspace.phase.publishing' : 'workspace.phase.publish'))}
      </button>
      <button type="button" class="ws-mini-button" data-action="ws-request-changes">${escapeHtml(t(locale, 'workspace.phase.requestChanges'))}</button>
    </div>`;
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
