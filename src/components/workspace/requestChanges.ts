/**
 * Request-changes modal — replaces the window.prompt with a styled dialog
 * whose input reuses the chat composer (same classes + send button), feeding
 * requestChangesAction with the feedback.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { SEND_ICON_SVG } from '../chat/ui/icons';
import { requestChangesAction } from './actions';
import type { AppState } from '../chat/app/state';

export const openRequestChanges = (): void => {
  store.state.workspace.requestChangesOpen = true;
  store.notify();
  setTimeout(() => {
    document.querySelector<HTMLElement>('[data-action="ws-rc-input"]')?.focus();
  }, 0);
};

export const closeRequestChanges = (): void => {
  store.state.workspace.requestChangesOpen = false;
  store.notify();
};

/** Submit the modal's input (send button / Enter). */
export const submitRequestChanges = (root: HTMLElement): void => {
  const input = root.querySelector<HTMLElement>('[data-action="ws-rc-input"]');
  const text = input?.textContent?.trim() ?? '';
  if (!text) return;
  closeRequestChanges();
  void requestChangesAction(text);
};

export const renderRequestChangesModal = (state: AppState): string => {
  if (!state.workspace.requestChangesOpen) return '';
  return `<div class="ws-rc" role="dialog" aria-modal="true" aria-label="Request changes">
      <div class="ws-rc__panel">
        <div class="ws-rc__head">
          <h2 class="ws-rc__heading">Request changes</h2>
          <button type="button" class="ws-mini-button" data-action="ws-rc-close"
            aria-label="Close">✕</button>
        </div>
        <p class="ws-rc__hint">Describe what should be different — the agent picks it up from there.</p>
        <div class="composer-card">
          <div class="composer-wrapper">
            <div
              class="composer-input"
              role="textbox"
              contenteditable="plaintext-only"
              aria-label="What should be changed?"
              data-empty="true"
              inputmode="text"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="sentences"
              data-action="ws-rc-input"></div>
            <button
              type="button"
              class="composer-send-button"
              data-action="ws-rc-send"
              aria-label="${escapeHtml('Send feedback')}"
              aria-disabled="true" disabled>
              ${SEND_ICON_SVG}
            </button>
          </div>
        </div>
      </div>
    </div>`;
};
