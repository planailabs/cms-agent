/**
 * Chat Cache — sessionStorage persistence for AI chat messages, keyed by chatId.
 * (Server is the source of truth; this cache enables instant restore on reload.)
 */

import { store } from '../../app/store';
import { chatStorageKey } from '../../constants';

/** Tool-call display info attached to role:'tool' messages. */
export interface ToolCallInfo {
  name: string;
  input?: unknown;
  result?: string;
  running?: boolean;
}

export type StoredMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'cancel' | 'tool';
  content: string;
  tool?: ToolCallInfo;
};

export const cacheAIChatMessages = (messages: StoredMessage[], chatId?: string) => {
  try {
    const id = chatId ?? store.state.activeChatId;
    if (!id) return;
    sessionStorage.setItem(chatStorageKey(id), JSON.stringify(messages));
  } catch {
    // sessionStorage full or unavailable — silently ignore
  }
};

export const readCachedAIChatMessages = (chatId?: string): StoredMessage[] | null => {
  try {
    const id = chatId ?? store.state.activeChatId;
    if (!id) return null;
    const raw = sessionStorage.getItem(chatStorageKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // corrupt data — ignore
  }
  return null;
};

export const clearAIChatMessages = (chatId?: string) => {
  try {
    const id = chatId ?? store.state.activeChatId;
    if (!id) return;
    sessionStorage.removeItem(chatStorageKey(id));
  } catch {
    // ignore
  }
};
