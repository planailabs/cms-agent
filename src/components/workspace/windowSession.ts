/**
 * Soft window session — per-window continuity WITHOUT server round-trips
 * for interactions. Each window has a sessionStorage UUID; its view state
 * (active chat, diff/compare modes, open code file, browser-compare setup,
 * sidebar) is mirrored to the server debounced. A window that reloads
 * restores itself silently; a FRESH window is offered the saved windows on
 * load ("continue where you left off") and can adopt one or start fresh.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { EditAnnotations, EditTool } from '@/injected/annotate';
import type { AppState } from '../chat/app/state';
import { ensureActiveChat, loadBranches, switchChat } from '../chat/actions/chat';
import {
  captureWindowState,
  closeWindow,
  openWindow,
  registerWindow,
  restoreWindowState,
} from './window';
import {
  applyRoute,
  initWorkspaceRouter,
  routeFromLocation,
  type WorkspaceRoute,
} from './router';
import type { WindowKind } from './state';
import { deviceByKey } from './devices';

const KEY = 'cms-window-id';
const SAVE_DEBOUNCE_MS = 800;

interface WindowViewState {
  v: 1;
  chatId: string | null;
  branchId: string | null;
  diffMode: string;
  compareMode: 'height' | 'content';
  /** Device preset the preview emulates (null/absent = responsive). */
  previewDevice?: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** v1 blobs carried these two hardcoded — kept optional for restore. */
  codeBrowser?: { open?: boolean; filePath: string | null; expanded: string[] };
  browserCompare?: { open?: boolean; a: string; b: string; mode: string };
  /** Active main-area window (replaces the v1 per-window open flags). */
  window?: WindowKind | null;
  /** Per-window persisted data from each WindowDef's capture(). */
  windows?: Record<string, unknown>;
  /** Active element-edit session — annotations survive reloads and server
   *  restarts (the deploy update-watcher reloads every window). */
  elementEdit?: { active: boolean; tool: EditTool; annotations: EditAnnotations | null };
}

export interface WindowSessionSummary {
  id: string;
  label: string;
  updatedAt: string;
}

const captureViewState = (state: AppState): WindowViewState => {
  const ws = state.workspace;
  return {
    v: 1,
    chatId: state.activeChatId,
    branchId: state.activeBranchId,
    diffMode: ws.diff.mode,
    compareMode: ws.compareMode,
    previewDevice: ws.previewDevice,
    sidebarWidth: ws.sidebarWidth,
    sidebarCollapsed: ws.sidebarCollapsed,
    window: ws.window,
    windows: captureWindowState(state),
    elementEdit: {
      active: ws.elementEdit.active,
      tool: ws.elementEdit.tool,
      annotations: ws.elementEdit.annotations,
    },
  };
};

const applyViewState = (blob: WindowViewState): void => {
  const st = store.state;
  const ws = st.workspace;
  // Chat first — switching resets chat-scoped workspace state.
  if (blob.chatId && blob.chatId !== st.activeChatId) {
    const known = st.branches.some((b) => b.chats.some((c) => c.id === blob.chatId));
    if (known) switchChat(blob.chatId);
  }
  ws.diff.mode = blob.diffMode as typeof ws.diff.mode;
  ws.compareMode = blob.compareMode === 'content' ? 'content' : 'height';
  ws.previewDevice = deviceByKey(blob.previewDevice)?.key ?? null;
  if (blob.sidebarWidth >= 280) ws.sidebarWidth = blob.sidebarWidth;
  ws.sidebarCollapsed = Boolean(blob.sidebarCollapsed);
  // Window restore: each registered window seeds its state from the blob's
  // windows map (v1 blobs mapped onto it), then the active one re-opens.
  const legacyWindows: Record<string, unknown> = {};
  if (blob.browserCompare) legacyWindows.browsers = blob.browserCompare;
  if (blob.codeBrowser) legacyWindows.code = blob.codeBrowser;
  const legacyActive: WindowKind | null = blob.codeBrowser?.open
    ? 'code'
    : blob.browserCompare?.open
      ? 'browsers'
      : null;
  const active = blob.window ?? legacyActive;
  restoreWindowState(blob.windows ?? legacyWindows, active === 'sessions' ? null : active);
  const ee = blob.elementEdit;
  if (ee?.active) {
    // previewAgent re-arms the iframe module on load (cms:edit-start carries
    // these annotations back into the page).
    ws.elementEdit = {
      active: true,
      tool: (['cursor', 'move', 'swap', 'draw', 'comment'] as EditTool[]).includes(ee.tool)
        ? ee.tool
        : 'cursor',
      annotations: ee.annotations ?? null,
      undoDepth: 0,
      canRedo: false,
    };
  }
  store.notify();
};

const sessionLabel = (state: AppState): string => {
  if (state.activeChatTitle) return state.activeChatTitle.slice(0, 120);
  const branch = state.branches.find((b) => b.id === state.activeBranchId);
  return branch?.name ?? '';
};

// ── Debounced mirror ─────────────────────────────────────────────────────

let windowId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved = '';

const scheduleSave = (): void => {
  if (!windowId || !store.state.user) return;
  const blob = captureViewState(store.state);
  const serialized = JSON.stringify(blob);
  if (serialized === lastSaved) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    lastSaved = serialized;
    void fetch('/api/window-sessions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: windowId, label: sessionLabel(store.state), state: blob }),
    }).catch(() => {
      lastSaved = ''; // retry on the next change
    });
  }, SAVE_DEBOUNCE_MS);
};

/** Mirror the current view state NOW (before an update reload), bypassing the
 *  debounce. Uses sendBeacon so it survives the imminent navigation. */
export const flushWindowSessionSave = (): void => {
  if (!windowId || !store.state.user) return;
  const blob = captureViewState(store.state);
  const serialized = JSON.stringify(blob);
  if (serialized === lastSaved) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  lastSaved = serialized;
  // keepalive lets the request outlive the imminent reload navigation.
  void fetch('/api/window-sessions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: windowId, label: sessionLabel(store.state), state: blob }),
    keepalive: true,
  }).catch(() => {});
};

// ── Boot: silent self-restore or the picker offer ────────────────────────

const fetchSession = async (id: string): Promise<WindowViewState | null> => {
  try {
    const res = await fetch(`/api/window-sessions/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { state?: WindowViewState };
    return data.state && data.state.v === 1 ? data.state : null;
  } catch {
    return null;
  }
};

/** URL route captured at boot; consumed by the FIRST bootInto so a later
 *  adopt/start-fresh choice is not re-routed to a by-then-stale URL. */
let bootRoute: WorkspaceRoute | null = null;

/** Boot the workspace INTO a saved window (or the default chat): branches
 *  first, then the saved chat if it still exists, else the default flow.
 *  A deep-linked URL (/chat/<id>[?window=…]) wins over the session blob;
 *  URL mirroring arms only after all of it settled. */
const bootInto = async (blob: WindowViewState | null): Promise<void> => {
  await loadBranches();
  const route = bootRoute;
  bootRoute = null;
  const routeKnown = Boolean(
    route?.chatId && store.state.branches.some((b) => b.chats.some((c) => c.id === route.chatId)),
  );
  const known =
    blob?.chatId && store.state.branches.some((b) => b.chats.some((c) => c.id === blob.chatId));
  if (!known && !routeKnown) await ensureActiveChat();
  if (blob) applyViewState(blob);
  if (route && (routeKnown || route.window)) {
    applyRoute({ chatId: routeKnown ? route.chatId : null, window: route.window });
  }
  initWorkspaceRouter();
};

/**
 * App boot entry — replaces the plain ensureActiveChat: the "continue where
 * you left off?" offer is the FIRST thing a fresh window shows; the
 * workspace only boots after the choice (restore → straight into the saved
 * window, no default-chat flash). A same-tab reload restores silently.
 */
export const bootWindowSession = async (): Promise<void> => {
  store.subscribe(scheduleSave);
  bootRoute = routeFromLocation(location);

  const existing = sessionStorage.getItem(KEY);
  if (existing) {
    // Same-tab reload: this window IS that session — boot straight into it.
    windowId = existing;
    await bootInto(await fetchSession(existing));
    return;
  }

  // A deep-linked chat is explicit intent — boot fresh into it instead of
  // offering the saved windows.
  if (bootRoute.chatId) {
    startFreshWindow();
    return;
  }

  // Fresh window: offer the saved windows BEFORE booting anything.
  try {
    const res = await fetch('/api/window-sessions');
    if (res.ok) {
      const data = (await res.json()) as { sessions?: WindowSessionSummary[] };
      if (data.sessions && data.sessions.length > 0) {
        store.state.workspace.windowPicker = data.sessions;
        store.notify();
        return; // boot continues when the user chooses
      }
    }
  } catch {
    /* offer is best-effort */
  }
  startFreshWindow();
};

export const startFreshWindow = (): void => {
  windowId = crypto.randomUUID();
  sessionStorage.setItem(KEY, windowId);
  if (store.state.workspace.window === 'sessions') store.state.workspace.window = null;
  store.state.workspace.windowPicker = null;
  store.notify();
  void bootInto(null);
};

export const adoptWindowSession = async (id: string): Promise<void> => {
  windowId = id;
  sessionStorage.setItem(KEY, id);
  if (store.state.workspace.window === 'sessions') store.state.workspace.window = null;
  store.state.workspace.windowPicker = null;
  store.notify();
  await bootInto(await fetchSession(id));
};

export const deleteWindowSession = async (id: string): Promise<void> => {
  await fetch(`/api/window-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
    () => {},
  );
  const picker = store.state.workspace.windowPicker;
  if (picker) {
    store.state.workspace.windowPicker = picker.filter((s) => s.id !== id);
    // Only the BOOT offer must resolve to a choice; a manually-opened
    // picker (window already has an id) simply closes when emptied.
    if (store.state.workspace.windowPicker.length === 0) {
      if (windowId) closeWindowPicker();
      else startFreshWindow();
    } else store.notify();
  }
};

/** Open the sessions window on demand (rail button) — switching this window
 *  to a saved session or managing the saved list from a running app. */
export const openWindowPicker = (): void => openWindow('sessions');

const loadSessionsList = async (): Promise<void> => {
  try {
    const res = await fetch('/api/window-sessions');
    if (!res.ok) return;
    const data = (await res.json()) as { sessions?: WindowSessionSummary[] };
    store.state.workspace.windowPicker = data.sessions ?? [];
    store.notify();
  } catch {
    /* best-effort */
  }
};

export const closeWindowPicker = (): void => {
  if (store.state.workspace.window === 'sessions') {
    closeWindow(); // onClose clears the list
    return;
  }
  store.state.workspace.windowPicker = null;
  store.notify();
};

/** True once this window has claimed an id (boot choice made). */
export const hasWindowId = (): boolean => windowId !== null;

// ── Picker modal ─────────────────────────────────────────────────────────

export const renderWindowPicker = (state: AppState): string => {
  const sessions = state.workspace.windowPicker;
  // Manual open (window already chosen) gets a plain Close; the boot offer
  // must resolve via restore or start-fresh.
  const manual = hasWindowId();
  if (!sessions && !manual) return '';
  const locale = uiLocale();

  const rows = (sessions ?? [])
    .map((s) => {
      const when = new Date(s.updatedAt).toLocaleString(locale);
      return `<div class="ws-git__row ws-caps__row">
          <span class="ws-git__info">
            <span class="ws-git__message">${escapeHtml(s.label || t(locale, 'workspace.window.unnamed'))}</span>
            <span class="ws-git__meta">${escapeHtml(when)}</span>
          </span>
          <button type="button" class="ws-mini-button ws-mini-button--primary"
            data-action="ws-wsn-restore" data-id="${escapeHtml(s.id)}">${escapeHtml(t(locale, 'workspace.window.restore'))}</button>
          <button type="button" class="ws-mini-button" data-action="ws-wsn-delete"
            data-id="${escapeHtml(s.id)}" aria-label="${escapeHtml(t(locale, 'workspace.window.delete'))}">×</button>
        </div>`;
    })
    .join('');

  const heading = manual ? 'workspace.window.headingManual' : 'workspace.window.heading';
  return `<div class="ws-archive ws-git" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(locale, heading))}">
      <div class="ws-archive__panel">
        <div class="ws-archive__head ws-git__head">
          <h2 class="ws-archive__heading">${escapeHtml(t(locale, heading))}</h2>
          <div class="ws-git__head-left">
            <button type="button" class="ws-mini-button" data-action="ws-wsn-fresh">${escapeHtml(t(locale, 'workspace.window.fresh'))}</button>
            ${manual ? `<button type="button" class="ws-mini-button" data-action="ws-wsn-close">${escapeHtml(t(locale, 'workspace.git.close'))}</button>` : ''}
          </div>
        </div>
        <div class="ws-archive__list ws-git__body">${rows || `<span class="ws-empty-note">${escapeHtml(t(locale, 'workspace.window.none'))}</span>`}</div>
      </div>
    </div>`;
};

registerWindow({
  kind: 'sessions',
  order: 60,
  icon: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="1.8" y="4.6" width="9.6" height="8.6" rx="1.4"/><path d="M4.8 4.6V3.2A1.4 1.4 0 016.2 1.8h6.6a1.4 1.4 0 011.4 1.4v6.6a1.4 1.4 0 01-1.4 1.4h-1.4"/></svg>`,
  tooltipKey: 'workspace.window.buttonTitle',
  railAction: 'ws-wsn-open',
  render: renderWindowPicker,
  onOpen: () => void loadSessionsList(),
  onClose: () => {
    store.state.workspace.windowPicker = null;
  },
});
