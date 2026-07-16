/**
 * Workspace Actions — phase transitions (approve/request-changes/preview/
 * publish/revert), diff loading, the navigation beacon, and context chips.
 *
 * All POSTs are same-origin JSON; non-2xx responses surface in the chat
 * error area (state.chat.aiChat.error pattern).
 */

import { store } from '../chat/app/store';
import { transition } from '../chat/actions/chat/stateMachine';
import { createChat, switchChat, createBranch } from '../chat/actions/chat';
import { publishCardReducer } from './publishCard';
import type { ContextChip, DiffPage } from './state';

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
    store.notify();
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

/** cms:selection / cms:element → context chip above the composer. */
export const attachContextChip = (chip: ContextChip): void => {
  const ws = store.state.workspace;
  const branch = store.state.branches.find((b) => b.id === store.state.activeBranchId);
  chip.context.branch = branch?.name;
  ws.contextChip = chip;
  ws.chipChoiceOpen = true;
  ws.pickerActive = false;
  store.notify();
};

export const removeContextChip = (): void => {
  const ws = store.state.workspace;
  ws.contextChip = null;
  ws.chipChoiceOpen = false;
  store.notify();
};

/** Chip popover → "New chat": create a chat on the branch, keep the chip. */
export const chipToNewChat = async (): Promise<void> => {
  const ws = store.state.workspace;
  const branchId = store.state.activeBranchId;
  const chip = ws.contextChip;
  if (!branchId) return;
  const chat = await createChat(branchId);
  if (!chat) {
    showChatError('Could not create the chat.');
    return;
  }
  switchChat(chat.id); // resets workspace chat state (incl. the chip) …
  store.state.workspace.contextChip = chip; // … so re-attach it to the new chat
  store.state.workspace.chipChoiceOpen = false;
  store.notify();
};

/** Chip popover → "Current chat": just keep the chip attached. */
export const chipToCurrentChat = (): void => {
  store.state.workspace.chipChoiceOpen = false;
  store.notify();
};
