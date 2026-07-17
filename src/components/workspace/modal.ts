/**
 * Generic input modal — one styled dialog whose input reuses the chat
 * composer (same classes, send button, aria-label placeholder). Callers pass
 * the texts and an onSubmit callback; request-changes and new-branch use it.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { SEND_ICON_SVG } from '../chat/ui/icons';
import type { AppState } from '../chat/app/state';

export interface InputModalConfig {
  title: string;
  hint?: string;
  /** Shown inside the empty composer (aria-label). */
  placeholder: string;
}

let onSubmit: ((text: string) => void) | null = null;

export const openInputModal = (config: InputModalConfig, submit: (text: string) => void): void => {
  onSubmit = submit;
  store.state.workspace.inputModal = config;
  store.notify();
  setTimeout(() => {
    document.querySelector<HTMLElement>('[data-action="ws-modal-input"]')?.focus();
  }, 0);
};

export const closeInputModal = (): void => {
  onSubmit = null;
  store.state.workspace.inputModal = null;
  store.notify();
};

/** Submit the modal's input (send button / Enter). */
export const submitInputModal = (): void => {
  const input = document.querySelector<HTMLElement>('[data-action="ws-modal-input"]');
  const text = input?.textContent?.trim() ?? '';
  if (!text) return;
  const cb = onSubmit;
  closeInputModal();
  cb?.(text);
};

export const renderInputModal = (state: AppState): string => {
  const modal = state.workspace.inputModal;
  if (!modal) return '';
  return `<div class="ws-rc" role="dialog" aria-modal="true" aria-label="${escapeHtml(modal.title)}">
      <div class="ws-rc__panel">
        <div class="ws-rc__head">
          <h2 class="ws-rc__heading">${escapeHtml(modal.title)}</h2>
          <button type="button" class="ws-mini-button" data-action="ws-modal-close"
            aria-label="Close">✕</button>
        </div>
        ${modal.hint ? `<p class="ws-rc__hint">${escapeHtml(modal.hint)}</p>` : ''}
        <div class="composer-card">
          <div class="composer-wrapper">
            <div
              class="composer-input"
              role="textbox"
              contenteditable="plaintext-only"
              aria-label="${escapeHtml(modal.placeholder)}"
              data-empty="true"
              inputmode="text"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="sentences"
              data-action="ws-modal-input"></div>
            <button
              type="button"
              class="composer-send-button"
              data-action="ws-modal-send"
              aria-label="Submit"
              aria-disabled="true" disabled>
              ${SEND_ICON_SVG}
            </button>
          </div>
        </div>
      </div>
    </div>`;
};
