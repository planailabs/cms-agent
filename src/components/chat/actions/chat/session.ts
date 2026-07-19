/**
 * Chat Session — restoreAIChatSession, fetchAIChatHistory, initAIChat,
 * ChatHistoryResult.
 */

import { store } from '../../app/store';
import { locales } from '../../content';
import { t, uiLocale } from '@/lib/i18n';
import {
  cacheAIChatMessages,
  readCachedAIChatMessages,
  type StoredMessage,
} from './cache';
import { connectEvents } from './sse';
import { getTranscriptEventSeq } from './events';
import { sendChatMessage } from './stateMachine';
import { MAX_PUBLISH_LOG_LINES } from '../../../workspace/publishCard';

export interface HistoryExecution {
  sha: string;
  summary: string;
  revertedBySha: string | null;
  createdAt?: string;
}

export interface ChatHistoryResult {
  messages: StoredMessage[];
  phase?: string;
  pendingQuestion?: Record<string, unknown>;
  executions: HistoryExecution[];
  lastError?: string | null;
  automatism?: {
    chatId: string;
    automatismType: string;
    status: string;
    step: number;
    steps: string[];
    lastError: string | null;
  } | null;
  targetAhead?: boolean;
  kind?: string;
  title?: string;
  archived?: boolean;
  workflowPhase?: string;
  branchId?: string;
  /** Latest publication (GET /api/chat/history) — rehydrates the publish card. */
  publication?: {
    id: string;
    sha: string;
    status: string;
    log: string;
    externalUrl: string | null;
  } | null;
}

export const initAIChat = (messages: StoredMessage[], phase: 'idle' | 'waiting' = 'idle') => {
  const state = store.state;
  state.chat = {
    userPrompt: messages[0]?.content ?? '',
    assistantVisibleText: '',
    assistantFullText: '',
    stream: { initialDelayMs: 0, chunkSize: 1, intervalMs: 0 },
    isStreaming: false,
    aiChat: {
      messages,
      phase,
    },
  };
  store.notify();
};

/**
 * Fetches chat history from the server and populates the sessionStorage cache.
 * Returns messages, phase, and pendingQuestion (if waiting_for_answer).
 */
export const fetchAIChatHistory = async (chatId?: string): Promise<ChatHistoryResult | null> => {
  try {
    const id = chatId ?? store.state.activeChatId;
    if (!id) return null;

    const response = await fetch(`/api/chat/history?chatId=${encodeURIComponent(id)}`);
    if (!response.ok) return null;

    const data = await response.json();
    const messages = (data.messages ?? []) as StoredMessage[];
    if (messages.length > 0) {
      cacheAIChatMessages(messages, id);
    }
    return {
      messages,
      phase: data.phase,
      pendingQuestion: data.pendingQuestion,
      executions: (data.executions ?? []) as HistoryExecution[],
      lastError: data.lastError ?? null,
      automatism: data.automatism ?? null,
      targetAhead: Boolean(data.targetAhead),
      kind: data.kind,
      title: data.title,
      archived: Boolean(data.archived),
      workflowPhase: data.workflowPhase,
      branchId: data.branchId,
      publication: data.publication ?? null,
    };
  } catch {
    // Network error — fall through
  }
  return null;
};

/**
 * Restores the active chat session (page load or chat switch).
 * - Shows cached messages instantly (sessionStorage)
 * - Fetches authoritative history from server
 */
export const restoreAIChatSession = (): void => {
  const state = store.state;
  const chatId = state.activeChatId;
  if (!chatId) return;

  // Don't re-init if already active
  if (state.chat?.aiChat) return;

  // Instant restore from sessionStorage cache (show immediately while server loads)
  const cached = readCachedAIChatMessages(chatId);
  if (cached && cached.length > 0) {
    initAIChat(cached);
  } else {
    initAIChat([]);
    store.notify();
  }

  // Pre-connect EventSource eagerly
  void connectEvents();

  // Fetch authoritative history from server — then decide whether to auto-send greeting
  const seqAtStart = getTranscriptEventSeq();
  void fetchAIChatHistory(chatId).then((result) =>
    applyHistoryResult(chatId, result, { mode: 'restore', transcriptSeqAtStart: seqAtStart }),
  );
};

/**
 * Re-sync after an SSE reconnect: events broadcast while disconnected are
 * gone, so the server snapshot is NEWER than the screen — server wins.
 */
export const resyncChatHistory = async (chatId: string): Promise<void> => {
  const result = await fetchAIChatHistory(chatId);
  applyHistoryResult(chatId, result, { mode: 'resync', transcriptSeqAtStart: -1 });
};

/**
 * Apply a history snapshot to the store. 'restore' (page load / chat switch)
 * lets live SSE state that landed during the fetch win; 'resync' (after a
 * reconnect gap) is server-wins.
 */
const applyHistoryResult = (
  chatId: string,
  result: ChatHistoryResult | null,
  opts: { mode: 'restore' | 'resync'; transcriptSeqAtStart: number },
): void => {
  const mc = store.state.chat?.aiChat;
  if (!mc || store.state.activeChatId !== chatId) return;
  const serverWins = opts.mode === 'resync';

  if (result) {
    store.state.workspace.targetAhead = Boolean(result.targetAhead);
    if (result.kind) store.state.activeChatKind = result.kind;
    if (result.title) store.state.activeChatTitle = result.title;
    store.state.activeChatArchived = Boolean(result.archived);
    // Server truth for phase/branch: archived chats are missing from the
    // sidebar list switchChat derives these from, which left the PREVIOUS
    // chat's branch (and a 'plan' fallback) active.
    if (result.workflowPhase) {
      store.state.workflowPhase = result.workflowPhase as typeof store.state.workflowPhase;
    }
    if (result.branchId) store.state.activeBranchId = result.branchId;
    store.notify();
  }

  // Rehydrate the automatism step bar (deployment chats)
  if (result?.automatism) {
    store.state.workspace.automatism = {
      forChatId: chatId,
      automatismType: result.automatism.automatismType,
      status: result.automatism.status,
      step: result.automatism.step,
      steps: result.automatism.steps,
      lastError: result.automatism.lastError,
    };
    store.notify();
  }

  // Rehydrate persisted executions (cards + publishable sha). On restore,
  // live SSE events that landed while the fetch was in flight win.
  if (result && (serverWins || result.executions.length > 0)) {
    const ws = store.state.workspace;
    if (serverWins || ws.executions.length === 0) {
      ws.executions = result.executions.map((e) => ({
        sha: e.sha,
        summary: e.summary,
        ...(e.revertedBySha ? { reverted: { revertSha: e.revertedBySha, by: '' } } : {}),
      }));
    }
    if (serverWins || !ws.executionSha) {
      const publishable = result.executions.filter((e) => !e.revertedBySha);
      ws.executionSha = publishable[publishable.length - 1]?.sha ?? null;
    }
    store.notify();
  }

  // Rehydrate the publish card from the latest publication ('external_unknown'
  // has no card equivalent and stays hidden).
  if (result) {
    const pub = result.publication;
    const ws = store.state.workspace;
    const status =
      pub && (pub.status === 'running' || pub.status === 'succeeded' || pub.status === 'failed')
        ? (pub.status as 'running' | 'succeeded' | 'failed')
        : null;
    const card =
      pub && status
        ? {
          sha: pub.sha,
          publicationId: pub.id,
          lines: pub.log
            ? pub.log.split('\n').filter(Boolean).slice(-MAX_PUBLISH_LOG_LINES)
            : [],
            status,
            externalUrl: pub.externalUrl ?? undefined,
          }
        : null;
    if (serverWins) {
      ws.publish = card;
      store.notify();
    } else if (card && !ws.publish) {
      ws.publish = card;
      store.notify();
    }
  }

  if (result && result.messages.length > 0) {
    // Live transcript events advanced the screen while the fetch was in
    // flight — this snapshot is older; applying it would erase them.
    if (!serverWins && getTranscriptEventSeq() !== opts.transcriptSeqAtStart) return;
    if (serverWins) mc.streamingText = undefined; // deltas in the gap are lost
    const cancelLabel = locales[store.state.localeKey].chatMode.cancelLabel;
      mc.messages = result.messages.map((m) =>
        m.role === 'cancel' ? { ...m, content: m.content || cancelLabel } : m,
      );
      // Interleave committed-execution cards at their chronological place
      for (const e of result.executions) {
        if (!e.createdAt) continue;
        const at = new Date(e.createdAt).getTime();
        let idx = mc.messages.findIndex(
          (m) => m.createdAt && new Date(m.createdAt).getTime() > at,
        );
        if (idx < 0) idx = mc.messages.length;
        mc.messages.splice(idx, 0, {
          role: 'execution',
          content: '',
          sha: e.sha,
          createdAt: e.createdAt,
        });
      }
      store.state.chat!.userPrompt = result.messages[0]?.content ?? '';

      // Restore pending question if server is waiting for an answer
      if (result.phase === 'waiting_for_answer' && result.pendingQuestion) {
        mc.phase = 'question';
        // Backwards compat: old format has { type, question, options }, new has { toolName, input }
        const pq = result.pendingQuestion;
        if (pq.toolName) {
          mc.clientPrompt = { toolName: pq.toolName as string, input: (pq.input ?? {}) as Record<string, unknown> };
        } else {
          mc.clientPrompt = { toolName: 'ask_question', input: pq };
        }
      } else if (result.lastError) {
        // A previous turn failed — show the stored error with Retry
        mc.phase = 'error';
        mc.error = result.lastError;
      } else if (result.phase === 'tool_pending') {
        // Interrupted mid-turn (e.g. server restart) — offer Continue
        mc.phase = 'idle';
        mc.canContinue = true;
      } else {
        mc.phase = 'idle';
      }

      store.notify();
  } else if (opts.mode === 'restore') {
    // Server has no history — auto-send greeting if configured
    const greeting = locales[store.state.localeKey].chatMode.greeting;
    if (greeting) {
      void sendChatMessage(greeting);
    }
  }
};

/**
 * Resumes an interrupted or failed turn (Retry / Continue buttons): clears
 * the local error state and asks the server to continue from stored state.
 */
export const continueChatSession = async (): Promise<void> => {
  const chatId = store.state.activeChatId;
  const mc = store.state.chat?.aiChat;
  if (!chatId || !mc) return;

  mc.error = undefined;
  mc.canContinue = false;
  mc.phase = 'waiting';
  store.notify();

  try {
    const res = await fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, type: 'continue', text: '' }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      mc.phase = 'error';
      mc.error = data.error ?? t(uiLocale(), 'chat.error.continueFailed', { status: res.status });
      store.notify();
    }
    // On 202 the SSE stream (thinking/text_delta/…) drives the UI from here.
  } catch {
    mc.phase = 'error';
    mc.error = t(uiLocale(), 'chat.error.network');
    store.notify();
  }
};
