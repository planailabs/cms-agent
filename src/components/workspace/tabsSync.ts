/**
 * Preview-tabs persistence — per (chat, user), stored via /api/chat/tabs and
 * carried to the user's other sessions by the chat-state snapshot (the server
 * sends no per-tab event; session.ts feeds the snapshot's tabs in here). Kept
 * separate from actions.ts so chat actions can import it without a cycle.
 */

import { store } from '../chat/app/store';
import { branchPreviewUrl } from './config';
import { previewBranchName } from './preview';
import { getPreviewIframe } from './previewAgent';

/** Identifies this browser session so its own echo is ignored. */
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
  // Fresh ids: a wholesale tab replacement remounts all per-tab iframes
  // (syncPreviewFrames), which also loads each tab's saved route.
  ws.previewTabIds = ws.previewTabs.map(() => crypto.randomUUID());
  ws.activeTabIndex = Math.min(Math.max(0, activeIndex), ws.previewTabs.length - 1);
  ws.previewRoute = ws.previewTabs[ws.activeTabIndex] ?? '/';
  store.notify();
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
  // Bind the chat at schedule time: firing after a chat switch would save
  // the NEW chat's freshly-reset default tabs under it, wiping its state.
  const chatId = store.state.activeChatId;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (store.state.activeChatId === chatId) saveTabs();
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

/** Snapshot tabs — apply when they are this user's, from another session. */
export const applyRemoteTabs = (data: Record<string, unknown>): void => {
  if (data.clientId === TABS_CLIENT_ID) return;
  if (data.userId !== store.state.user?.id) return;
  if (!Array.isArray(data.tabs) || data.tabs.length === 0) return;
  applyTabs(
    data.tabs.filter((t): t is string => typeof t === 'string'),
    typeof data.activeIndex === 'number' ? data.activeIndex : 0,
  );
};
