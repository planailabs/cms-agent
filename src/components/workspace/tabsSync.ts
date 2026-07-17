/**
 * Preview-tabs persistence — per (chat, user), stored via /api/chat/tabs and
 * synced live to the user's other sessions through the chat SSE channel
 * (`tabs_updated`). Kept separate from actions.ts so chat actions can import
 * it without an import cycle.
 */

import { store } from '../chat/app/store';
import { branchPreviewUrl } from './config';
import { previewBranchName } from './preview';
import { getPreviewIframe } from './previewAgent';

/** Identifies this browser session so its own tabs_updated echo is ignored. */
export const TABS_CLIENT_ID = crypto.randomUUID();

/** Points the preview iframe at a route (direct src set — the frame region's
 *  markup is route-independent, so re-renders won't reload it). */
export const loadPreviewRoute = (route: string): void => {
  const iframe = getPreviewIframe();
  if (iframe) iframe.src = branchPreviewUrl(previewBranchName(store.state), route);
};

const applyTabs = (tabs: string[], activeIndex: number): void => {
  const ws = store.state.workspace;
  ws.previewTabs = tabs.slice(0, 50);
  ws.activeTabIndex = Math.min(Math.max(0, activeIndex), ws.previewTabs.length - 1);
  const route = ws.previewTabs[ws.activeTabIndex] ?? '/';
  const changed = ws.previewRoute !== route;
  ws.previewRoute = route;
  store.notify();
  if (changed) loadPreviewRoute(route);
};

// ── Save (debounced) ─────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const saveTabs = (): void => {
  const chatId = store.state.activeChatId;
  const ws = store.state.workspace;
  if (!chatId) return;
  void fetch('/api/chat/tabs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId,
      tabs: ws.previewTabs,
      activeIndex: ws.activeTabIndex,
      clientId: TABS_CLIENT_ID,
    }),
  }).catch(() => {
    /* best-effort */
  });
};

export const scheduleTabsSave = (): void => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveTabs();
  }, 600);
};

// ── Load / remote sync ───────────────────────────────────────────────────────

/** Restores the caller's saved tabs after a chat switch (best-effort). */
export const loadChatTabs = async (chatId: string): Promise<void> => {
  try {
    const res = await fetch(`/api/chat/tabs?chatId=${encodeURIComponent(chatId)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { tabs: string[] | null; activeIndex?: number };
    if (store.state.activeChatId !== chatId) return; // switched away meanwhile
    if (!Array.isArray(data.tabs) || data.tabs.length === 0) return;
    applyTabs(data.tabs, data.activeIndex ?? 0);
  } catch {
    /* best-effort */
  }
};

/** tabs_updated SSE event — apply when it is this user's from another session. */
export const onRemoteTabsUpdated = (data: Record<string, unknown>): void => {
  if (data.clientId === TABS_CLIENT_ID) return;
  if (data.userId !== store.state.user?.id) return;
  if (!Array.isArray(data.tabs) || data.tabs.length === 0) return;
  applyTabs(
    data.tabs.filter((t): t is string => typeof t === 'string'),
    typeof data.activeIndex === 'number' ? data.activeIndex : 0,
  );
};
