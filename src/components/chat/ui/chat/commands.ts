/**
 * Composer support for `/commands` (lib/commands): the autocomplete that opens
 * on a leading slash, and the chip that replaces a completed command in the
 * composer so the user sees it took effect before sending.
 *
 * Presentation only. The server parses the text it receives and decides what
 * a command does — a chip here is a preview of that, never the thing itself,
 * so a stale or hand-edited composer cannot make the chat do something the
 * server did not agree to.
 */
import { COMMANDS, activeFragment, matchCommands, parseMessage } from '@/lib/commands';
import { escapeHtml } from '../../utils/html';

const MENU = '[data-command-menu]';

/** The chip shown beside a message (transcript) or in the composer. */
export const commandChipHtml = (name: string): string =>
  `<span class="command-chip" title="${escapeHtml(
    COMMANDS.find((c) => c.name === name)?.description ?? '',
  )}">/${escapeHtml(name)}</span>`;

/** Empty container the composer renders once; filled as the user types. */
export const commandMenuHtml = (): string =>
  `<div class="command-menu" data-command-menu hidden role="listbox" aria-label="Commands"></div>`;

const optionHtml = (name: string, description: string, active: boolean): string =>
  `<button type="button" class="command-option${active ? ' is-active' : ''}"
     role="option" aria-selected="${active}" data-command-option="${escapeHtml(name)}">
     <span class="command-option__name">/${escapeHtml(name)}</span>
     <span class="command-option__desc">${escapeHtml(description)}</span>
   </button>`;

/** Caret offset within the composer's text, or the text length when unknown. */
function caretOffset(input: HTMLElement): number {
  const selection = input.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return (input.textContent ?? '').length;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(input);
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
  return range.toString().length;
}

/**
 * Open, filter or close the menu for the composer's current content. Returns
 * the options currently offered, so the caller can decide whether a keypress
 * belongs to the menu or to the message.
 */
export function syncCommandMenu(input: HTMLElement): string[] {
  const menu = input.closest('.composer-card')?.querySelector<HTMLElement>(MENU);
  if (!menu) return [];
  const text = input.textContent ?? '';
  const fragment = activeFragment(text, caretOffset(input));
  const matches = fragment === null ? [] : matchCommands(fragment);
  if (matches.length === 0) {
    menu.hidden = true;
    menu.innerHTML = '';
    return [];
  }
  menu.innerHTML = matches.map((c, i) => optionHtml(c.name, c.description, i === 0)).join('');
  menu.hidden = false;
  return matches.map((c) => c.name);
}

export function closeCommandMenu(input: HTMLElement): void {
  const menu = input.closest('.composer-card')?.querySelector<HTMLElement>(MENU);
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
}

/** Name of the highlighted option, or null when the menu is closed. */
export function activeCommandOption(input: HTMLElement): string | null {
  const menu = input.closest('.composer-card')?.querySelector<HTMLElement>(MENU);
  if (!menu || menu.hidden) return null;
  return menu.querySelector<HTMLElement>('.command-option.is-active')?.dataset.commandOption ?? null;
}

/** Move the highlight; wraps at both ends so ArrowUp from the top is useful. */
export function moveCommandHighlight(input: HTMLElement, delta: number): void {
  const menu = input.closest('.composer-card')?.querySelector<HTMLElement>(MENU);
  if (!menu || menu.hidden) return;
  const options = [...menu.querySelectorAll<HTMLElement>('.command-option')];
  if (options.length === 0) return;
  const current = options.findIndex((o) => o.classList.contains('is-active'));
  const next = (current + delta + options.length) % options.length;
  options.forEach((o, i) => {
    o.classList.toggle('is-active', i === next);
    o.setAttribute('aria-selected', String(i === next));
  });
}

/**
 * Write `/name ` into the composer and put the caret after it. The command
 * stays visible as text: it is part of the message the user is composing, and
 * the chip beside the send button is what confirms it was understood.
 */
export function applyCommand(input: HTMLElement, name: string): void {
  const text = input.textContent ?? '';
  const rest = text.replace(/^\/[a-z0-9-]*\s*/i, '');
  input.textContent = `/${name} ${rest}`;
  input.setAttribute('data-empty', 'false');
  const selection = input.ownerDocument.getSelection();
  const node = input.firstChild;
  if (selection && node) {
    const range = input.ownerDocument.createRange();
    range.setStart(node, `/${name} `.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  closeCommandMenu(input);
  syncComposerChip(input);
}

/** Show the chip once the composer text opens with a complete command. */
export function syncComposerChip(input: HTMLElement): void {
  const card = input.closest('.composer-card');
  const slot = card?.querySelector<HTMLElement>('[data-command-chip]');
  if (!slot) return;
  const { command } = parseMessage(input.textContent ?? '');
  slot.innerHTML = command ? commandChipHtml(command.name) : '';
}
