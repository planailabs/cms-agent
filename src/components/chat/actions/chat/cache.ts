/**
 * Chat Cache — sessionStorage persistence for AI chat messages, keyed by chatId.
 * (Server is the source of truth; this cache enables instant restore on reload.)
 */

import { store } from '../../app/store';
import { chatStorageKey } from '../../constants';
import type { TranslatedMessage } from '@/lib/i18n';

/** Tool-call display info attached to role:'tool' messages. */
export interface ToolCallInfo {
  name: string;
  input?: unknown;
  result?: string;
  running?: boolean;
}

/** File attached to a user message (for display in the transcript). */
export interface AttachmentDisplay {
  id?: string;
  filename: string;
  mime: string;
  /** Object URL for a just-sent image preview (absent after reload). */
  url?: string;
}

export type StoredMessage = {
  id?: string;
  // 'execution' is a client-side pseudo message anchoring the committed-
  // execution card at its chronological place in the transcript
  role: 'user' | 'assistant' | 'cancel' | 'tool' | 'automatism' | 'compaction' | 'execution';
  content: string;
  /** role 'automatism': i18n container — rendered in the viewer's language,
   *  falling back to the stored English `content`. */
  tm?: TranslatedMessage;
  /** role 'user': files attached to the message. */
  attachments?: AttachmentDisplay[];
  tool?: ToolCallInfo;
  /** role 'execution': commit sha, resolved against workspace.executions. */
  sha?: string;
  /** Server timestamp (history) — used to interleave executions. */
  createdAt?: string;
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
