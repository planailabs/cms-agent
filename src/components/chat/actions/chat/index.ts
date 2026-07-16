/**
 * Chat Actions — barrel re-exports and top-level actions
 * (loadBranches, createBranch, createChat, switchChat, ensureActiveChat).
 */

import { store } from '../../app/store';
import type { Branch, ChatSummary } from '../../app/state';
import { disconnectEvents } from './sse';
import { restoreAIChatSession } from './session';
import { resetWorkspaceChatState } from '../../../workspace/state';

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
  store.notify();

  // Restore/init the new chat
  restoreAIChatSession();
};

/**
 * Ensures there is an active chat to talk to: loads branches, and creates
 * a default branch/chat if the workspace is empty, then opens the chat.
 */
export const ensureActiveChat = async (): Promise<void> => {
  await loadBranches();
  const state = store.state;

  let branch: Branch | null = state.branches[0] ?? null;
  if (!branch) {
    branch = await createBranch('main');
    if (!branch) return;
  }

  let chat: ChatSummary | null = branch.chats[0] ?? null;
  if (!chat) {
    chat = await createChat(branch.id);
    if (!chat) return;
  }

  switchChat(chat.id);
};
