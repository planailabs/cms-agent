/**
 * Workspace URL routing: /chat/<chatId>[?window=<kind>] mirrors the active
 * chat + main-area window, so every chat/window state is addressable (deep
 * links, back/forward). The URL is DERIVED state — the store stays the
 * single source of truth; popstate routes back through the same state
 * machine (switchChat / openWindow / closeWindow), never mutating directly.
 */
import { store } from '../chat/app/store';
import type { AppState } from '../chat/app/state';
import { switchChat } from '../chat/actions/chat';
import { closeWindow, openWindow, registeredWindows } from './window';
import type { WindowKind } from './state';

export interface WorkspaceRoute {
  chatId: string | null;
  window: WindowKind | null;
}

const CHAT_PATH = /^\/chat\/([A-Za-z0-9_-]+)\/?$/;

/** Parse a location into a route; unknown window kinds are dropped. */
export const routeFromLocation = (loc: { pathname: string; search: string }): WorkspaceRoute => {
  const m = CHAT_PATH.exec(loc.pathname);
  const win = new URLSearchParams(loc.search).get('window');
  const known = registeredWindows().some((d) => d.kind === win);
  return { chatId: m ? m[1] : null, window: known ? (win as WindowKind) : null };
};

/** Canonical URL for the current state. */
export const urlForState = (state: AppState): string => {
  if (!state.activeChatId) return '/';
  const win = state.workspace.window;
  return `/chat/${state.activeChatId}${win ? `?window=${win}` : ''}`;
};

let lastUrl: string | null = null;
let applying = false;
let armed = false;

/** Store subscriber: mirror state → URL. The first write after boot replaces
 *  (normalizing / to the booted chat without an extra history entry); later
 *  chat/window changes push so back/forward walks them. */
const syncUrl = (): void => {
  if (applying) return;
  const url = urlForState(store.state);
  if (url === lastUrl) return;
  const replace = lastUrl === null || location.pathname + location.search === url;
  lastUrl = url;
  if (!replace) history.pushState(null, '', url);
  else if (location.pathname + location.search !== url) history.replaceState(null, '', url);
};

/** Apply a route to the store without echoing it back into history. Unknown
 *  chat ids are ignored (default-chat boot handles them). */
export const applyRoute = (route: WorkspaceRoute): void => {
  applying = true;
  try {
    if (route.chatId && route.chatId !== store.state.activeChatId) {
      const known = store.state.branches.some((b) => b.chats.some((c) => c.id === route.chatId));
      if (known) switchChat(route.chatId);
    }
    if (route.window) openWindow(route.window);
    else if (store.state.workspace.window) closeWindow();
  } finally {
    applying = false;
  }
  lastUrl = urlForState(store.state);
};

/** Arm URL mirroring + back/forward handling — called once, at the end of
 *  the window-session boot (so restore doesn't spray history entries). */
export const initWorkspaceRouter = (): void => {
  if (armed) return;
  armed = true;
  lastUrl = null; // first sync normalizes the URL via replaceState
  store.subscribe(syncUrl);
  window.addEventListener('popstate', () => applyRoute(routeFromLocation(location)));
  syncUrl();
};

/** Test hook: reset module state. */
export const resetWorkspaceRouterForTests = (): void => {
  lastUrl = null;
  applying = false;
  armed = false;
};
