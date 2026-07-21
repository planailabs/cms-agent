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
import type { AppState } from '../chat/app/state';
import { ensureActiveChat, loadBranches, switchChat } from '../chat/actions/chat';
import { openFile } from './codeBrowser';

const KEY = 'cms-window-id';
const SAVE_DEBOUNCE_MS = 800;

interface WindowViewState {
  v: 1;
  chatId: string | null;
  branchId: string | null;
  diffMode: string;
  compareMode: 'height' | 'content';
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  codeBrowser: { open: boolean; filePath: string | null; expanded: string[] };
  browserCompare: { open: boolean; a: string; b: string; mode: string };
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
    sidebarWidth: ws.sidebarWidth,
    sidebarCollapsed: ws.sidebarCollapsed,
    codeBrowser: {
      open: ws.codeBrowser.open,
      filePath: ws.codeBrowser.filePath,
      expanded: [...ws.codeBrowser.expanded],
    },
    browserCompare: {
      open: ws.browserCompare.open,
      a: ws.browserCompare.a,
      b: ws.browserCompare.b,
      mode: ws.browserCompare.mode,
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
  if (blob.sidebarWidth >= 280) ws.sidebarWidth = blob.sidebarWidth;
  ws.sidebarCollapsed = Boolean(blob.sidebarCollapsed);
  const bc = blob.browserCompare;
  if (bc) {
    ws.browserCompare.open = Boolean(bc.open);
    ws.browserCompare.mode = (bc.mode as typeof ws.browserCompare.mode) || 'highlight';
    if (bc.a) ws.browserCompare.a = bc.a as typeof ws.browserCompare.a;
    if (bc.b) ws.browserCompare.b = bc.b as typeof ws.browserCompare.b;
  }
  const cb = blob.codeBrowser;
  if (cb?.open) {
    ws.codeBrowser.open = true;
    ws.codeBrowser.expanded = Array.isArray(cb.expanded) ? cb.expanded : ['.'];
    if (cb.filePath) void openFile(cb.filePath);
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

/** Boot the workspace INTO a saved window (or the default chat): branches
 *  first, then the saved chat if it still exists, else the default flow. */
const bootInto = async (blob: WindowViewState | null): Promise<void> => {
  await loadBranches();
  const known =
    blob?.chatId && store.state.branches.some((b) => b.chats.some((c) => c.id === blob.chatId));
  if (!known) await ensureActiveChat();
  if (blob) applyViewState(blob);
};

/**
 * App boot entry — replaces the plain ensureActiveChat: the "continue where
 * you left off?" offer is the FIRST thing a fresh window shows; the
 * workspace only boots after the choice (restore → straight into the saved
 * window, no default-chat flash). A same-tab reload restores silently.
 */
export const bootWindowSession = async (): Promise<void> => {
  store.subscribe(scheduleSave);

  const existing = sessionStorage.getItem(KEY);
  if (existing) {
    // Same-tab reload: this window IS that session — boot straight into it.
    windowId = existing;
    await bootInto(await fetchSession(existing));
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
  store.state.workspace.windowPicker = null;
  store.notify();
  void bootInto(null);
};

export const adoptWindowSession = async (id: string): Promise<void> => {
  windowId = id;
  sessionStorage.setItem(KEY, id);
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

/** Open the window list on demand (Windows button) — switching this window
 *  to a saved session or managing the saved list from a running app. */
export const openWindowPicker = async (): Promise<void> => {
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
  store.state.workspace.windowPicker = null;
  store.notify();
};

/** True once this window has claimed an id (boot choice made). */
export const hasWindowId = (): boolean => windowId !== null;

// ── Picker modal ─────────────────────────────────────────────────────────

export const renderWindowPicker = (state: AppState): string => {
  const sessions = state.workspace.windowPicker;
  if (!sessions) return '';
  const locale = uiLocale();
  // Manual open (window already chosen) gets a plain Close; the boot offer
  // must resolve via restore or start-fresh.
  const manual = hasWindowId();

  const rows = sessions
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
