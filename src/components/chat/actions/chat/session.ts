/**
 * Chat Session — restoreAIChatSession, fetchAIChatHistory, initAIChat,
 * ChatHistoryResult.
 */

import { store } from '../../app/store';
import type { WorkflowPhase } from '../../app/state';
import { createInitialDiffState } from '../../../workspace/state';
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

/** Server-computed full chat snapshot (streamed-state plan phase 1) —
 *  mirror of ChatStateSnapshot in src/lib/agent/chatState.ts. */
export interface ChatStateSnapshot {
  seq: number;
  epoch: string;
  chatId: string;
  title: string;
  kind: string;
  archived: boolean;
  workflowPhase: string;
  branchId: string;
  workBranch: string;
  planJson: unknown;
  executionSha: string | null;
  executions: HistoryExecution[];
  publication: {
    id: string;
    sha: string;
    status: string;
    log: string;
    externalUrl: string | null;
  } | null;
  automatism: {
    chatId: string;
    automatismType: string;
    status: string;
    step: number;
    steps: string[];
    lastError: string | null;
  } | null;
  targetAhead: boolean;
  tabs: { tabs: string[]; activeIndex: number; byUserId: string } | null;
  turnPhase: string;
  canResume: boolean;
  pendingQuestion: { toolName: string; input: Record<string, unknown> } | null;
  lastError: string | null;
}

/** Per-chat stale-drop guard for `state` events (epoch resets on server restart). */
const stateSeqByChat = new Map<string, { epoch: string; seq: number }>();

/** Highest applied snapshot seq for a chat — captured before a history fetch
 *  so a stale (seq-0) snapshot can be skipped when live events overtook it. */
export const getChatStateSeq = (chatId: string): number =>
  stateSeqByChat.get(chatId)?.seq ?? 0;

/**
 * Apply a full server snapshot by plain replacement — the server always
 * wins. Transcript messages and local UI state are untouched by design.
 * `staleGuard` (restore-mode history): skip if a sequenced snapshot arrived
 * since the fetch started — the live stream is newer than the fetch.
 */
export const applyChatState = (
  snapshot: ChatStateSnapshot,
  clientId?: string,
  opts?: { staleGuard?: number; allowIdleDowngrade?: boolean },
): void => {
  const st = store.state;
  const guard = stateSeqByChat.get(snapshot.chatId);

  // Stale sequenced snapshots are dropped ENTIRELY (sidebar included — a
  // late event must not revert a fresher title/phase there either).
  if (snapshot.seq !== 0) {
    if (guard && guard.epoch === snapshot.epoch && snapshot.seq <= guard.seq) return;
    stateSeqByChat.set(snapshot.chatId, { epoch: snapshot.epoch, seq: snapshot.seq });
  }

  // Sidebar effects apply for ANY chat on this SSE channel (rename/archive
  // reach non-active viewers of the same chat list).
  for (const branch of st.branches) {
    const idx = branch.chats.findIndex((x) => x.id === snapshot.chatId);
    if (idx < 0) continue;
    if (snapshot.archived) {
      branch.chats.splice(idx, 1); // done chats live in the archive view
    } else {
      branch.chats[idx].title = snapshot.title;
      branch.chats[idx].workflowPhase = snapshot.workflowPhase as WorkflowPhase;
    }
  }

  if (snapshot.chatId !== st.activeChatId) {
    store.notify();
    return;
  }
  // seq 0 = history snapshot (unsequenced): applied unless live events
  // overtook the fetch (staleGuard); never recorded in the guard map.
  if (snapshot.seq === 0 && opts?.staleGuard !== undefined && (guard?.seq ?? 0) > opts.staleGuard) {
    return;
  }

  const phaseChanged = st.workflowPhase !== snapshot.workflowPhase;
  st.workflowPhase = snapshot.workflowPhase as typeof st.workflowPhase;
  st.activeBranchId = snapshot.branchId;
  st.activeChatTitle = snapshot.title;
  st.activeChatKind = snapshot.kind as typeof st.activeChatKind;
  st.activeChatArchived = snapshot.archived;

  const ws = st.workspace;
  // Reset the diff viewer so it reloads on (re-)entering PREVIEW.
  if (phaseChanged) ws.diff = createInitialDiffState();
  ws.plan = (snapshot.planJson as typeof ws.plan) ?? null;
  ws.executions = snapshot.executions.map((e) => ({
    sha: e.sha,
    summary: e.summary,
    ...(e.revertedBySha ? { reverted: { revertSha: e.revertedBySha, by: '' } } : {}),
  }));
  ws.executionSha = snapshot.executionSha;
  ws.targetAhead = snapshot.targetAhead;

  const pub = snapshot.publication;
  const status =
    pub && (pub.status === 'running' || pub.status === 'succeeded' || pub.status === 'failed')
      ? (pub.status as 'running' | 'succeeded' | 'failed')
      : null;
  const card =
    pub && status
      ? {
          sha: pub.sha,
          publicationId: pub.id,
          lines: pub.log ? pub.log.split('\n').filter(Boolean).slice(-MAX_PUBLISH_LOG_LINES) : [],
          status,
          externalUrl: pub.externalUrl ?? undefined,
        }
      : null;
  // Mid-run, live publish_log lines outrun the persisted log — keep them.
  if (
    card &&
    ws.publish &&
    ws.publish.publicationId === card.publicationId &&
    card.status === 'running' &&
    ws.publish.lines.length > card.lines.length
  ) {
    card.lines = ws.publish.lines;
  }
  ws.publish = card;

  ws.automatism = snapshot.automatism
    ? {
        forChatId: snapshot.chatId,
        automatismType: snapshot.automatism.automatismType,
        status: snapshot.automatism.status,
        step: snapshot.automatism.step,
        steps: snapshot.automatism.steps,
        lastError: snapshot.automatism.lastError,
      }
    : ws.automatism?.forChatId === snapshot.chatId
      ? null
      : ws.automatism;

  // Remote turn state: derive the composer/card phase from the snapshot.
  // Conservative rule: never downgrade an optimistic 'waiting' (a POSTed
  // turn the server hasn't persisted yet) — the done/error stream events
  // own that edge; snapshots own question/error/crash-recovery.
  const mc = st.chat?.aiChat;
  if (mc) {
    if (snapshot.turnPhase === 'waiting_for_answer' && snapshot.pendingQuestion) {
      mc.phase = 'question';
      mc.clientPrompt = {
        toolName: snapshot.pendingQuestion.toolName,
        input: snapshot.pendingQuestion.input ?? {},
      };
      mc.canContinue = false;
    } else if (snapshot.turnPhase === 'idle') {
      if (snapshot.lastError) {
        mc.phase = 'error';
        mc.error = snapshot.lastError;
      } else if (
        mc.phase === 'question' ||
        mc.phase === 'error' ||
        // Reconnect resync: a 'done' lost in the SSE gap must not leave the
        // spinner running forever — the server-wins path may downgrade.
        (opts?.allowIdleDowngrade &&
          (mc.phase === 'waiting' || mc.phase === 'compacting'))
      ) {
        mc.phase = 'idle';
        mc.clientPrompt = undefined;
        mc.error = undefined;
        mc.streamingText = undefined;
      }
      mc.canContinue = false;
    } else if (snapshot.canResume) {
      // The persisted tool call has no active server turn (crash/restart).
      // This server-authoritative edge may replace a stale local spinner.
      mc.phase = 'idle';
      mc.canContinue = true;
    } else {
      mc.canContinue = false;
    }
  }

  store.notify();

  // Per-user tabs — user/echo filtering lives in onRemoteTabsUpdated.
  if (snapshot.tabs) {
    void import('../../../workspace/tabsSync').then(({ onRemoteTabsUpdated }) =>
      onRemoteTabsUpdated({
        userId: snapshot.tabs!.byUserId,
        tabs: snapshot.tabs!.tabs,
        activeIndex: snapshot.tabs!.activeIndex,
        clientId,
      }),
    );
  }
};

export interface ChatHistoryResult {
  messages: StoredMessage[];
  /** Full snapshot — the ONLY state source (workflow AND turn state):
   *  applied via applyChatState, same shape as the SSE `state` event. */
  state?: ChatStateSnapshot;
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
    return { messages, state: data.state as ChatStateSnapshot | undefined };
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
  const stateSeqAtStart = getChatStateSeq(chatId);
  void fetchAIChatHistory(chatId).then((result) =>
    applyHistoryResult(chatId, result, {
      mode: 'restore',
      transcriptSeqAtStart: seqAtStart,
      stateSeqAtStart,
    }),
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
 * Apply a history snapshot to the store. Workflow/side state comes as ONE
 * full snapshot (result.state) applied server-wins via applyChatState; the
 * restore/resync distinction only matters for the transcript ('restore'
 * lets a live stream that advanced during the fetch win).
 */
const applyHistoryResult = (
  chatId: string,
  result: ChatHistoryResult | null,
  opts: { mode: 'restore' | 'resync'; transcriptSeqAtStart: number; stateSeqAtStart?: number },
): void => {
  const mc = store.state.chat?.aiChat;
  if (!mc || store.state.activeChatId !== chatId) return;
  const serverWins = opts.mode === 'resync';

  if (result?.state) {
    applyChatState(
      result.state,
      undefined,
      serverWins
        ? { allowIdleDowngrade: true } // reconnect: events in the gap are gone
        : { staleGuard: opts.stateSeqAtStart ?? 0 },
    );
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
      for (const e of result.state?.executions ?? []) {
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
      // Turn phase (question/error/canContinue) was derived from the
      // snapshot by applyChatState above — remote turn state.
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
