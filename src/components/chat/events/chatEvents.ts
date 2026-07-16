import { delegateEvent } from '../utils/dom';
import {
  sendChatMessage,
  answerChatQuestion,
  cancelChatQuestion,
} from '../actions/chat';

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

  // Chat: Send
  delegateEvent(
    app,
    'click',
    '[data-action="machine-config-send"]',
    () => {
      const input = getMachineConfigInput();
      if (!input) return;
      const value = getMachineConfigValue(input);
      if (!value) return;
      clearMachineConfigInput(input);
      void sendChatMessage(value);
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
      const input = keyEvent.target as HTMLElement;
      const value = getMachineConfigValue(input);
      if (!value) return;
      clearMachineConfigInput(input);
      void sendChatMessage(value);
    },
  );

  // Chat: sync empty state and send button
  delegateEvent(
    app,
    'input',
    '[data-action="machine-config-input"]',
    (event) => {
      const input = event.target as HTMLElement;
      const hasContent = (input.textContent ?? '').trim().length > 0;
      input.setAttribute('data-empty', hasContent ? 'false' : 'true');
      const btn = app.querySelector<HTMLButtonElement>(
        '[data-action="machine-config-send"]',
      );
      if (btn) {
        btn.disabled = !hasContent;
        btn.setAttribute('aria-disabled', String(!hasContent));
      }
    },
  );

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
