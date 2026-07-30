import { delegateEvent } from '../utils/dom';
import {
  sendChatMessage,
  answerChatQuestion,
  cancelChatQuestion,
} from '../actions/chat';
import {
  activeCommandOption,
  applyCommand,
  closeCommandMenu,
  moveCommandHighlight,
  syncCommandMenu,
  syncComposerChip,
} from '../ui/chat/commands';
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
    syncComposerChip(input);
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

  // Chat: Enter Key (Shift+Enter inserts newline). While the command menu is
  // open it owns Enter/Tab/Arrows — picking a command must not send the
  // half-typed message underneath it.
  delegateEvent(
    app,
    'keydown',
    '[data-action="machine-config-input"]',
    (event) => {
      const keyEvent = event as KeyboardEvent;
      const input = keyEvent.target as HTMLElement;
      const highlighted = activeCommandOption(input);
      if (highlighted) {
        if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
          keyEvent.preventDefault();
          moveCommandHighlight(input, keyEvent.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (keyEvent.key === 'Enter' || keyEvent.key === 'Tab') {
          keyEvent.preventDefault();
          applyCommand(input, highlighted);
          return;
        }
        if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault();
          closeCommandMenu(input);
          return;
        }
      }
      if (keyEvent.key !== 'Enter') return;
      if (keyEvent.shiftKey) return; // allow default newline insertion
      keyEvent.preventDefault();
      closeCommandMenu(input);
      submitComposer(input);
    },
  );

  // Chat: pick a command with the mouse
  delegateEvent(app, 'mousedown', '[data-command-option]', (event) => {
    event.preventDefault(); // keep the caret in the composer
    const name = (event.target as HTMLElement).closest<HTMLElement>('[data-command-option]')
      ?.dataset.commandOption;
    const input = getMachineConfigInput();
    if (name && input) applyCommand(input, name);
  });

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
      syncCommandMenu(input);
      syncComposerChip(input);
    },
  );

  // Moving the caret changes whether a /fragment is being typed at all.
  delegateEvent(app, 'keyup', '[data-action="machine-config-input"]', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key.startsWith('Arrow') || key === 'Home' || key === 'End') {
      syncCommandMenu(event.target as HTMLElement);
    }
  });
  delegateEvent(app, 'blur', '[data-action="machine-config-input"]', (event) => {
    closeCommandMenu(event.target as HTMLElement);
  });

  // Chat: paste into the composer — files (ctrl+v or the context menu both
  // fire 'paste') become attachments; very long text becomes a text
  // attachment instead of flooding the input (Claude-style).
  const PASTE_AS_ATTACHMENT_CHARS = 4000;
  delegateEvent(
    app,
    'paste',
    '[data-action="machine-config-input"]',
    (event) => {
      const clip = (event as ClipboardEvent).clipboardData;
      if (!clip) return;
      if (clip.files.length > 0) {
        event.preventDefault();
        stageFiles(clip.files);
        return;
      }
      const text = clip.getData('text/plain');
      if (text.length > PASTE_AS_ATTACHMENT_CHARS) {
        event.preventDefault();
        stageFiles([
          new File([text], 'pasted-text.txt', { type: 'text/plain' }),
        ]);
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

  // A drop that misses the dropzone (or arrives while no composer is
  // rendered) must never navigate the workspace away to the file.
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());

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

  // Chat: pick_color confirm — send the chosen color as the answer
  delegateEvent(app, 'click', '[data-action="mc-color-confirm"]', (event, target) => {
    event.stopPropagation();
    const input = app.querySelector<HTMLInputElement>('[data-action="mc-color-input"]');
    if (!input) return;
    target.setAttribute('disabled', '');
    answerChatQuestion(input.value);
  });

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
