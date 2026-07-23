import { delegateEvent } from '../utils/dom';
import {
  sendChatMessage,
  answerChatQuestion,
  cancelChatQuestion,
} from '../actions/chat';
import {
  clearAttachments,
  composerHasContent,
  readyAttachmentMeta,
  removeAttachment,
  stageFiles,
} from '../actions/chat/attachments';

export const registerChatEvents = (app: HTMLElement) => {
  // Chat: helpers for contenteditable input
  const getMachineConfigInput = () =>
    app.querySelector<HTMLElement>('[data-action="machine-config-input"]');

  const getMachineConfigValue = (input: HTMLElement): string =>
    (input.textContent ?? '').trim();

  const clearMachineConfigInput = (input: HTMLElement) => {
    input.textContent = '';
    input.setAttribute('data-empty', 'true');
    const btn = app.querySelector<HTMLButtonElement>(
      '[data-action="machine-config-send"]',
    );
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
  };

  // Send text + any staged attachments; a message with attachments only
  // (no text) is allowed.
  const submitComposer = (input: HTMLElement) => {
    const value = getMachineConfigValue(input);
    const attachments = readyAttachmentMeta();
    if (!value && attachments.length === 0) return;
    clearMachineConfigInput(input);
    clearAttachments();
    void sendChatMessage(value, undefined, attachments);
  };

  // Chat: Send
  delegateEvent(
    app,
    'click',
    '[data-action="machine-config-send"]',
    () => {
      const input = getMachineConfigInput();
      if (input) submitComposer(input);
    },
  );

  // Chat: Enter Key (Shift+Enter inserts newline)
  delegateEvent(
    app,
    'keydown',
    '[data-action="machine-config-input"]',
    (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key !== 'Enter') return;
      if (keyEvent.shiftKey) return; // allow default newline insertion
      keyEvent.preventDefault();
      submitComposer(keyEvent.target as HTMLElement);
    },
  );

  // Chat: sync empty state and send button (text OR ready attachments enable)
  delegateEvent(
    app,
    'input',
    '[data-action="machine-config-input"]',
    (event) => {
      const input = event.target as HTMLElement;
      const text = input.textContent ?? '';
      input.setAttribute('data-empty', text.trim().length > 0 ? 'false' : 'true');
      const btn = app.querySelector<HTMLButtonElement>(
        '[data-action="machine-config-send"]',
      );
      if (btn) {
        const enabled = composerHasContent(text);
        btn.disabled = !enabled;
        btn.setAttribute('aria-disabled', String(!enabled));
      }
    },
  );

  // Chat: open the file picker
  delegateEvent(app, 'click', '[data-action="chat-attach"]', () => {
    app.querySelector<HTMLInputElement>('[data-action="chat-attach-input"]')?.click();
  });

  // Chat: files chosen via the picker
  delegateEvent(app, 'change', '[data-action="chat-attach-input"]', (_event, target) => {
    const inputEl = target as HTMLInputElement;
    if (inputEl.files?.length) stageFiles(inputEl.files);
    inputEl.value = ''; // allow re-selecting the same file
  });

  // Chat: remove a staged attachment
  delegateEvent(app, 'click', '[data-action="chat-attach-remove"]', (_event, target) => {
    const localId = target.getAttribute('data-local-id');
    if (localId) removeAttachment(localId);
  });

  // Chat: drag & drop files onto the composer
  delegateEvent(app, 'dragover', '[data-action="chat-dropzone"]', (event, target) => {
    event.preventDefault();
    target.classList.add('is-dragover');
  });
  delegateEvent(app, 'dragleave', '[data-action="chat-dropzone"]', (_event, target) => {
    target.classList.remove('is-dragover');
  });
  delegateEvent(app, 'drop', '[data-action="chat-dropzone"]', (event, target) => {
    const dragEvent = event as DragEvent;
    dragEvent.preventDefault();
    target.classList.remove('is-dragover');
    if (dragEvent.dataTransfer?.files.length) stageFiles(dragEvent.dataTransfer.files);
  });

  // Chat: Example-prompt chip (empty state) — fills the composer
  delegateEvent(
    app,
    'click',
    '[data-action="chat-example-prompt"]',
    (_event, target) => {
      const promptText = target.getAttribute('data-prompt');
      if (!promptText) return;
      const input = getMachineConfigInput();
      if (!input) return;
      input.textContent = promptText;
      input.setAttribute('data-empty', 'false');
      const btn = app.querySelector<HTMLButtonElement>(
        '[data-action="machine-config-send"]',
      );
      if (btn) {
        btn.disabled = false;
        btn.setAttribute('aria-disabled', 'false');
      }
      input.focus();
      // Place the caret at the end of the filled text
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    },
  );

  // Chat: Question Choice (multiple-choice buttons)
  delegateEvent(
    app,
    'click',
    '[data-action="mc-question-choice"]',
    (event, target) => {
      event.stopPropagation();
      const choice = target.getAttribute('data-choice');
      if (!choice) return;
      // Visual feedback: mark selected, briefly disable all
      target.classList.add('is-selected');
      const allButtons = app.querySelectorAll<HTMLButtonElement>(
        '[data-action="mc-question-choice"], [data-action="mc-question-cancel"]',
      );
      allButtons.forEach((btn) => {
        btn.disabled = true;
        btn.classList.add('is-disabled');
      });
      setTimeout(() => {
        answerChatQuestion(choice);
      }, 200);
    },
  );

  // Chat: Cancel Question
  delegateEvent(
    app,
    'click',
    '[data-action="mc-question-cancel"]',
    (event) => {
      event.stopPropagation();
      cancelChatQuestion();
    },
  );
};
