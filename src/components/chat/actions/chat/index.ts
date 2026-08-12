/**
 * Chat Actions — barrel re-exports and top-level actions
 * (loadBranches, createBranch, createChat, switchChat, ensureActiveChat).
 */

import { store } from '../../app/store';
import type { Branch, ChatSummary } from '../../app/state';
import { disconnectEvents } from './sse';
import { initAIChat, restoreAIChatSession } from './session';
import { resetWorkspaceChatState } from '../../../workspace/state';
import { loadChatTabs } from '../../../workspace/tabsSync';
import { loadNotifyState } from '../../../workspace/notifyModal';

// ─── Re-exports ─────────────────────────────────────────────────────────────

export {
  cacheAIChatMessages,
  readCachedAIChatMessages,
  clearAIChatMessages,
} from './cache';

export { disconnectEvents } from './sse';

export {
  restoreAIChatSession,
  fetchAIChatHistory,
  initAIChat,
} from './session';

export {
  sendChatMessage,
  answerChatQuestion,
  cancelChatQuestion,
} from './stateMachine';

// ─── Top-level Actions ──────────────────────────────────────────────────────

/**
 * Loads all branches (with their chats) from the server into state.
 */
export const loadBranches = async (): Promise<void> => {
  try {
    const res = await fetch('/api/branches');
    if (!res.ok) return;
    const data = await res.json();
    store.state.branches = (data.branches ?? []) as Branch[];
    store.notify();
  } catch {
    // Network error — keep whatever we have
  }
};

/**
 * Creates a new branch on the server and adds it to state.
 */
export const createBranch = async (name: string): Promise<Branch | null> => {
  try {
    const res = await fetch('/api/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Server returns { branch } (201); tolerate a flat payload too
    const created = data.branch ?? data;
    const branch: Branch = {
      id: created.id,
      name: created.name ?? name,
      chats: created.chats ?? [],
    };
    store.state.branches.push(branch);
    store.notify();
    return branch;
  } catch {
    return null;
  }
};

/**
 * Creates a new chat in a branch on the server and adds it to state.
 */
export const createChat = async (branchId: string, title?: string): Promise<ChatSummary | null> => {
  try {
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchId, title }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Server returns { chat } (201); tolerate a flat payload too
    const created = data.chat ?? data;
    const user = store.state.user;
    const chat: ChatSummary = {
      id: created.id,
      title: created.title ?? title ?? '',
      workflowPhase: created.workflowPhase ?? 'plan',
      workBranch: created.workBranch ?? '',
      kind: created.kind ?? 'workflow',
      createdBy: user ? { id: user.id, name: user.name } : null,
    };
    const branch = store.state.branches.find((b) => b.id === branchId);
    if (branch) branch.chats.push(chat);
    store.notify();
    return chat;
  } catch {
    return null;
  }
};

/**
 * Switches the active chat. Disconnects current SSE, updates active
 * branch/chat/workflow phase, and restores/inits the new chat.
 */
export const switchChat = (chatId: string): void => {
  const state = store.state;
  if (state.activeChatId === chatId && state.chat?.aiChat) return;

  // Disconnect current EventSource
  disconnectEvents();

  // Clear current chat state and point at the new chat
  state.chat = null;
  state.activeChatId = chatId;

  // Clear chat-scoped workspace state (cards, publish, diff, chips)
  resetWorkspaceChatState(state.workspace);

  // Derive branch + workflow phase from the branch list
  const branch = state.branches.find((b) => b.chats.some((c) => c.id === chatId));
  if (branch) state.activeBranchId = branch.id;
  const summary = branch?.chats.find((c) => c.id === chatId);
  state.workflowPhase = summary?.workflowPhase ?? 'plan';
  if (summary) state.activeChatKind = summary.kind ?? 'workflow';
  state.activeChatTitle = summary?.title ?? null;
  state.activeChatArchived = false; // authoritative value arrives with history
  store.notify();

  // Restore the user's saved preview tabs for this chat (best-effort)
  void loadChatTabs(chatId);
  // Whether this viewer armed "notify me when it's done" here (best-effort):
  // the bell has to be right before it is clicked, not after.
  void loadNotifyState(chatId);

  // Restore/init the new chat
  restoreAIChatSession();
};

/**
 * Draft chat: an empty conversation on a branch with no Chat row behind it
 * yet. The preview falls back to the target branch (nothing to build), and
 * the row is created by the first message — see sendChatMessage.
 */
export const startDraftChat = (branchId: string): void => {
  const state = store.state;
  disconnectEvents();
  state.chat = null;
  state.activeChatId = null;
  state.activeBranchId = branchId;
  state.activeChatKind = 'workflow';
  state.activeChatTitle = null;
  state.activeChatArchived = false;
  state.workflowPhase = 'plan';
  resetWorkspaceChatState(state.workspace);
  initAIChat([]); // notifies; the composer needs its container
};

/**
 * Ensures there is somewhere to talk: loads branches, creates the default
 * branch if the workspace is empty, then opens a draft chat on it.
 */
export const ensureActiveChat = async (): Promise<void> => {
  await loadBranches();
  const state = store.state;

  let branch: Branch | null = state.branches[0] ?? null;
  if (!branch) {
    branch = await createBranch('main');
    if (!branch) return;
  }
  startDraftChat(branch.id);
};
