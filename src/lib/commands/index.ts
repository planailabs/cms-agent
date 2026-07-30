/**
 * Chat commands — a `/name` prefix on a sent message that switches something
 * on for the chat. Parameterless by design: a command is a mode switch the
 * user can type, not an argument-passing syntax. The composer autocompletes
 * them, the transcript renders the one a message carried as a chip beside it.
 *
 * A command's effect belongs to the CHAT, not the message: `/plan` says "for
 * this conversation, show me a plan and let me approve it" and stays on until
 * the workflow leaves the plan phase. The message itself keeps the command so
 * the transcript still explains, later, why the chat behaved differently.
 *
 * Adding one: append to COMMANDS. The registry is the single source for the
 * parser, the autocomplete list and the server-side validation, so a new
 * command needs no other wiring.
 */

export interface ChatCommand {
  /** Typed after the slash; lowercase, no spaces. */
  name: string;
  /** One line, shown in the composer's autocomplete. */
  description: string;
  /** Chat columns to set when a message carries it. */
  effect: Record<string, unknown>;
}

export const COMMANDS: ChatCommand[] = [
  {
    name: 'plan',
    description: 'Plan first — the agent proposes a plan and waits for your approval',
    effect: { planMode: true },
  },
];

export const findCommand = (name: string): ChatCommand | undefined =>
  COMMANDS.find((c) => c.name === name.toLowerCase());

/** Commands whose name starts with the typed fragment (no slash). */
export const matchCommands = (fragment: string): ChatCommand[] => {
  const f = fragment.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(f));
};

export interface ParsedMessage {
  /** The recognized command, or null when the text carries none. */
  command: ChatCommand | null;
  /** The message with the command prefix removed. */
  text: string;
}

/**
 * Split a leading `/command` off a message. Only an exact, known command at
 * the very start counts: an unknown `/foo`, or a slash mid-sentence, is
 * ordinary text — the user gets no silent reinterpretation of what they typed,
 * and a message that merely mentions a path stays intact.
 */
export function parseMessage(text: string): ParsedMessage {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+|$)/i.exec(text);
  const command = match ? findCommand(match[1]) : undefined;
  if (!match || !command) return { command: null, text };
  return { command, text: text.slice(match[0].length) };
}

/**
 * The `/fragment` being typed at the caret, for the autocomplete. Only while
 * the caret is inside a slash-word at the START of the composer — commands
 * prefix a message, so nothing else should open the menu.
 */
export function activeFragment(text: string, caret: number): string | null {
  const match = /^\/([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  return match ? match[1] : null;
}
