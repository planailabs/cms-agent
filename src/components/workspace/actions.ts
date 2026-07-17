/**
 * Workspace Actions — phase transitions (approve/request-changes/preview/
 * publish/revert), diff loading, the navigation beacon, and context chips.
 *
 * All POSTs are same-origin JSON; non-2xx responses surface in the chat
 * error area (state.chat.aiChat.error pattern).
 */

import { store } from '../chat/app/store';
import { transition } from '../chat/actions/chat/stateMachine';
import { createChat, switchChat, createBranch, loadBranches } from '../chat/actions/chat';
import { publishCardReducer } from './publishCard';
import { loadPreviewRoute, scheduleTabsSave } from './tabsSync';
import type { BrowserName, ContextChip, DiffPage } from './state';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Shows an error in the chat error area (aiChat.error pattern). */
export const showChatError = (message: string): void => {
  const mc = store.state.chat?.aiChat;
  if (!mc) return;
  transition(mc, 'error');
  mc.error = message;
  store.notify();
};

interface JsonResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

/** Same-origin JSON POST; on non-2xx shows the error in the chat area. */
const postJson = async (url: string, body: unknown): Promise<JsonResult> => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      showChatError((data.error as string) ?? `Request failed (${res.status})`);
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    showChatError('Network error — please try again');
    return { ok: false, status: 0, data: {} };
  }
};

/** Marks the pending workflow question as handled and shows the thinking UI. */
const enterWaiting = (): void => {
  const mc = store.state.chat?.aiChat;
  if (mc) transition(mc, 'waiting');
  store.notify();
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase actions
// ─────────────────────────────────────────────────────────────────────────────

/** propose_plan card → Approve plan. */
export const approvePlanAction = async (): Promise<void> => {
  const chatId = store.state.activeChatId;
  if (!chatId) return;
  const res = await postJson(`/api/chats/${encodeURIComponent(chatId)}/approve-plan`, {});
  if (res.ok) enterWaiting();
};

/** Request changes (plan card, phase bar, diff viewer). Prompts for feedback. */
export const requestChangesAction = async (feedback?: string): Promise<void> => {
  const chatId = store.state.activeChatId;
  if (!chatId) return;
  const text = feedback ?? window.prompt('What should be changed?')?.trim();
  if (!text) return;
  const res = await postJson(`/api/chats/${encodeURIComponent(chatId)}/request-changes`, {
    feedback: text,
  });
  if (res.ok) enterWaiting();
};

/** finish_execution card → Create preview. */
export const createPreviewAction = async (): Promise<void> => {
  const chatId = store.state.activeChatId;
  if (!chatId) return;
  const res = await postJson(`/api/chats/${encodeURIComponent(chatId)}/to-preview`, {});
  if (res.ok) enterWaiting();
};

/** finish_execution card → "Not yet — keep chatting" (local dismiss). */
export const dismissFinishExecution = (): void => {
  const mc = store.state.chat?.aiChat;
  if (mc?.phase === 'question' && mc.clientPrompt) {
    mc.clientPrompt.dismissed = true;
    store.notify();
  }
};

/** execution_committed card → Undo (git revert on the branch). */
export const undoExecutionAction = async (sha: string): Promise<void> => {
  const branchId = store.state.activeBranchId;
  if (!branchId || !sha) return;
  const ws = store.state.workspace;
  const card = ws.executions.find((e) => e.sha === sha);
  if (card) {
    card.busy = true;
    store.notify();
  }
  const res = await postJson(`/api/branches/${encodeURIComponent(branchId)}/revert`, { sha });
  if (!res.ok && card) {
    card.busy = false;
    store.notify();
  }
  // Success: the execution_reverted SSE event updates the card.
};

/** Publish the reviewed sha (phase bar / diff viewer / retry). */
export const publishAction = async (sha?: string): Promise<void> => {
  const chatId = store.state.activeChatId;
  const ws = store.state.workspace;
  const targetSha = sha ?? ws.executionSha ?? ws.publish?.sha;
  if (!chatId) return;
  if (!targetSha) {
    showChatError('No reviewed commit to publish yet.');
    return;
  }
  const res = await postJson(`/api/chats/${encodeURIComponent(chatId)}/publish`, {
    sha: targetSha,
  });
  if (res.ok) {
    ws.publish = publishCardReducer(null, {
      type: 'start',
      sha: targetSha,
      publicationId: res.data.publicationId as string | undefined,
    });
    store.notify();
    // Follow the deployment where it happens: the automatism posts its
    // progress into the per-publish deployment chat.
    const deployChatId = res.data.deployChatId as string | undefined;
    if (deployChatId) {
      await loadBranches(); // the new deployment chat appears in the sidebar
      switchChat(deployChatId);
    }
  }
  // Failures surface via postJson's error toast.
};

/** Step-bar ▶ Resume — re-runs the paused automatism's failed step. */
export const resumeAutomatismAction = async (): Promise<void> => {
  const chatId = store.state.activeChatId;
  if (!chatId) return;
  const res = await postJson(`/api/chats/${encodeURIComponent(chatId)}/resume-automatism`, {});
  if (res.ok) {
    const a = store.state.workspace.automatism;
    // Optimistic; the automatism_state SSE event confirms right after
    if (a && a.forChatId === chatId) a.status = 'running';
    store.notify();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Branch / chat helpers (workspace buttons)
// ─────────────────────────────────────────────────────────────────────────────

/** "New branch" button — prompts for a DNS-safe name. */
export const newBranchAction = async (): Promise<void> => {
  const name = window
    .prompt('Branch name (DNS-safe: lowercase letters, digits, hyphens):')
    ?.trim()
    .toLowerCase();
  if (!name) return;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    showChatError('Branch name must be DNS-safe (lowercase letters, digits, hyphens).');
    return;
  }
  const branch = await createBranch(name);
  if (!branch) {
    showChatError(`Could not create branch "${name}" (it may already exist).`);
    return;
  }
  const chat = await createChat(branch.id);
  if (chat) switchChat(chat.id);
};

/** "New chat" button on a branch row. */
export const newChatAction = async (branchId: string): Promise<void> => {
  const chat = await createChat(branchId);
  if (chat) switchChat(chat.id);
  else showChatError('Could not create the chat.');
};

// ─────────────────────────────────────────────────────────────────────────────
// Diff viewer
// ─────────────────────────────────────────────────────────────────────────────

/** Loads GET /api/diff/:chatId/pages into workspace.diff. */
export const loadDiffPages = async (): Promise<void> => {
  const chatId = store.state.activeChatId;
  const diff = store.state.workspace.diff;
  if (!chatId || diff.loading) return;

  diff.loading = true;
  diff.error = null;
  diff.forChatId = chatId;
  store.notify();

  try {
    const res = await fetch(`/api/diff/${encodeURIComponent(chatId)}/pages`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const cur = store.state.workspace.diff;
    if (store.state.activeChatId !== chatId || cur.forChatId !== chatId) return; // stale
    if (!res.ok) {
      cur.loading = false;
      cur.error = (data.error as string) ?? `Failed to load changed pages (${res.status})`;
      store.notify();
      return;
    }
    cur.pages = (data.pages as DiffPage[]) ?? [];
    cur.unresolved = (data.unresolved as string[]) ?? [];
    cur.selectedRoute = cur.pages[0]?.route ?? null;
    cur.loading = false;
    cur.loaded = true;
    store.notify();
  } catch {
    const cur = store.state.workspace.diff;
    if (cur.forChatId === chatId) {
      cur.loading = false;
      cur.error = 'Network error while loading the diff.';
      store.notify();
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview overlay protocol (workspace side)
// ─────────────────────────────────────────────────────────────────────────────

const CONTEXT_BEACON_MIN_INTERVAL_MS = 1000;
let lastBeaconAt = 0;
let beaconTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBeacon: { url: string; route: string } | null = null;

const flushBeacon = (): void => {
  const chatId = store.state.activeChatId;
  const payload = pendingBeacon;
  pendingBeacon = null;
  if (!chatId || !payload) return;
  lastBeaconAt = Date.now();
  void fetch('/api/chat/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, url: payload.url, route: payload.route }),
  }).catch(() => {
    /* beacon is best-effort */
  });
};

/** cms:navigation → remember the route + throttled context beacon (1/s). */
export const onPreviewNavigation = (url: string, route: string): void => {
  const ws = store.state.workspace;
  if (ws.previewRoute !== route) {
    ws.previewRoute = route;
    ws.previewTabs[ws.activeTabIndex] = route;
    store.notify();
    scheduleTabsSave();
  }

  pendingBeacon = { url, route };
  const elapsed = Date.now() - lastBeaconAt;
  if (elapsed >= CONTEXT_BEACON_MIN_INTERVAL_MS) {
    flushBeacon();
  } else if (!beaconTimer) {
    beaconTimer = setTimeout(() => {
      beaconTimer = null;
      flushBeacon();
    }, CONTEXT_BEACON_MIN_INTERVAL_MS - elapsed);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview tabs / address bar
// ─────────────────────────────────────────────────────────────────────────────

/** Accepts "/about/", "about" or a pasted full URL; returns a root-relative route. */
const normalizeRoute = (raw: string): string => {
  let route = raw.trim();
  if (/^https?:\/\//i.test(route)) {
    try {
      const u = new URL(route);
      route = u.pathname + u.search + u.hash;
    } catch {
      // fall through with the raw value
    }
  }
  if (!route.startsWith('/')) route = `/${route}`;
  return route;
};

export const navigatePreviewTo = (raw: string): void => {
  const ws = store.state.workspace;
  const route = normalizeRoute(raw);
  ws.previewRoute = route;
  ws.previewTabs[ws.activeTabIndex] = route;
  store.notify();
  loadPreviewRoute(route);
  scheduleTabsSave();
};

export const switchPreviewTab = (index: number): void => {
  const ws = store.state.workspace;
  if (index === ws.activeTabIndex || index < 0 || index >= ws.previewTabs.length) return;
  ws.activeTabIndex = index;
  ws.previewRoute = ws.previewTabs[index];
  store.notify();
  loadPreviewRoute(ws.previewRoute);
  scheduleTabsSave();
};

export const closePreviewTab = (index: number): void => {
  const ws = store.state.workspace;
  if (ws.previewTabs.length <= 1 || index < 0 || index >= ws.previewTabs.length) return;
  const wasActive = index === ws.activeTabIndex;
  ws.previewTabs.splice(index, 1);
  if (ws.activeTabIndex >= ws.previewTabs.length) ws.activeTabIndex = ws.previewTabs.length - 1;
  else if (index < ws.activeTabIndex) ws.activeTabIndex -= 1;
  ws.previewRoute = ws.previewTabs[ws.activeTabIndex];
  store.notify();
  if (wasActive) loadPreviewRoute(ws.previewRoute);
  scheduleTabsSave();
};

export const newPreviewTab = (): void => {
  const ws = store.state.workspace;
  ws.previewTabs.push('/');
  ws.activeTabIndex = ws.previewTabs.length - 1;
  ws.previewRoute = '/';
  store.notify();
  loadPreviewRoute('/');
  scheduleTabsSave();
};

/** cms:selection / cms:element → context chip above the composer, attached to
 *  the current chat (the next message carries it). */
export const attachContextChip = (chip: ContextChip): void => {
  const ws = store.state.workspace;
  const branch = store.state.branches.find((b) => b.id === store.state.activeBranchId);
  chip.context.branch = branch?.name;
  ws.contextChip = chip;
  ws.pickerActive = false;
  store.notify();
};

// ─────────────────────────────────────────────────────────────────────────────
// Cross-browser comparison overlay
// ─────────────────────────────────────────────────────────────────────────────

export const openBrowserCompare = (): void => {
  store.state.workspace.browserCompare.open = true;
  store.notify();
};
export const closeBrowserCompare = (): void => {
  store.state.workspace.browserCompare.open = false;
  store.notify();
};
export const setBrowserCompareBrowser = (which: 'a' | 'b', name: BrowserName): void => {
  store.state.workspace.browserCompare[which] = name;
  store.notify();
};
export const setBrowserCompareMode = (mode: 'highlight' | 'onion'): void => {
  store.state.workspace.browserCompare.mode = mode;
  store.notify();
};
export const toggleBrowserCompareOverlay = (): void => {
  const bc = store.state.workspace.browserCompare;
  bc.overlayVisible = !bc.overlayVisible;
  store.notify();
};

export const removeContextChip = (): void => {
  store.state.workspace.contextChip = null;
  store.notify();
};
