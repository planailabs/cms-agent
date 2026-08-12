/**
 * The browser tab as a progress indicator.
 *
 * A turn can run for minutes, and the person who started it is usually in
 * another tab by then. The title is the one piece of this app that is visible
 * from there, so it carries the only two facts that matter: it is still
 * working, or it has stopped.
 *
 * "Done" is deliberately sticky and deliberately unstickable: it survives
 * until the tab is actually looked at, and clears the moment it is. A turn
 * that ends while somebody is watching never sets it — they saw it happen.
 */
import { store } from '../app/store';
import { APP_NAME } from '../constants';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../app/state';

/** Composer phases that mean the agent is mid-turn. */
const RUNNING_PHASES = new Set(['waiting', 'streaming', 'tool', 'compacting']);

/** The sidebar list is authoritative (the agent renames chats mid-turn);
 *  activeChatTitle covers chats that are not in it, e.g. archived ones. */
const activeChatTitle = (state: AppState): string => {
  const summary = state.branches
    .flatMap((branch) => branch.chats)
    .find((chat) => chat.id === state.activeChatId);
  return (summary?.title ?? state.activeChatTitle ?? '').trim();
};

/** Exported for the test: pure, given a phase and whether the tab is hidden. */
export const pageTitleFor = (
  state: AppState,
  opts: { running: boolean; done: boolean },
): string => {
  const title = activeChatTitle(state);
  if (!title) return APP_NAME;
  if (opts.running) return t(uiLocale(), 'chat.pageTitle.working', { title });
  if (opts.done) return t(uiLocale(), 'chat.pageTitle.done', { title });
  return APP_NAME;
};

let wasRunning = false;
let finishedUnseen = false;

const sync = (): void => {
  const state = store.state;
  const phase = state.chat?.aiChat?.phase;
  const running = phase !== undefined && RUNNING_PHASES.has(phase);

  if (running) {
    finishedUnseen = false;
  } else if (wasRunning) {
    // The turn ended just now — worth flagging only to a tab nobody is on.
    finishedUnseen = document.hidden;
  }
  wasRunning = running;
  // Looking at the tab IS the acknowledgement.
  if (!document.hidden) finishedUnseen = false;

  const next = pageTitleFor(state, { running, done: finishedUnseen });
  if (document.title !== next) document.title = next;
};

/** Wire the title to the store. Idempotent per document. */
export const startPageTitleWatcher = (): void => {
  store.subscribe(sync);
  document.addEventListener('visibilitychange', sync);
  sync();
};
