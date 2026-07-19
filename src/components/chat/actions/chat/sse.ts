/**
 * Chat SSE — EventSource lifecycle: connect, disconnect, reconnection backoff, postMessage.
 *
 * Auth is a same-origin session cookie — no Authorization headers or tokens.
 */

import { store } from '../../app/store';
import { handleServerEvent } from './events';
import { transition } from './stateMachine';
import { t, uiLocale } from '@/lib/i18n';
import type { PageContext } from '../../../workspace/state';

/** Persistent EventSource connection */
let eventSource: EventSource | null = null;

/** Chat the current EventSource is subscribed to */
let connectedChatId: string | null = null;

/** Whether the close was intentional (chat switch / sign-out) — suppress reconnect */
let intentionalClose = false;

/** Reconnection backoff state */
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Promise that resolves when the current EventSource is open */
let connectPromise: Promise<void> | null = null;

/**
 * POST a message/answer to the server. Events arrive via SSE.
 */
export const postMessage = async (payload: {
  type: 'message' | 'answer';
  text: string;
  pageContext?: PageContext;
}) => {
  const chatId = store.state.activeChatId;
  if (!chatId) return;

  const res = await fetch('/api/chat/message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatId, ...payload }),
  });

  if (res.status === 409) {
    // Already processing in another tab — SSE will deliver events
    return;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const mc = store.state.chat?.aiChat;
    if (mc) {
      transition(mc, 'error');
      mc.error = (data as any).error ?? t(uiLocale(), 'chat.error.generic');
      store.notify();
    }
  }
  // 202 — events arrive via EventSource
};

/** Drop a dead EventSource and schedule a backoff reconnect. */
const dropAndScheduleReconnect = (es: EventSource): void => {
  console.warn('[sse-client] EventSource error/disconnected');
  if (eventSource === es) {
    eventSource = null;
    connectedChatId = null;
    connectPromise = null;
  }
  es.close();

  if (!intentionalClose) {
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30_000);
    reconnectAttempt++;
    console.log(`[sse-client] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => { void connectEvents(); }, delay);
  }
};

/**
 * Opens a persistent EventSource connection for receiving server events
 * for the active chat. Returns a promise that resolves when the
 * connection is open.
 */
export const connectEvents = (): Promise<void> => {
  const chatId = store.state.activeChatId;
  if (!chatId) return Promise.resolve();

  // Already connected to the right chat
  if (eventSource?.readyState === EventSource.OPEN && connectedChatId === chatId) {
    return Promise.resolve();
  }

  // Connected (or connecting) to a different chat — start over
  if (connectedChatId !== null && connectedChatId !== chatId) {
    disconnectEvents();
  }

  if (connectPromise) return connectPromise;

  intentionalClose = false;

  connectPromise = (async () => {
    try {
      const es = new EventSource(`/api/chat/events?chatId=${encodeURIComponent(chatId)}`);
      eventSource = es;
      connectedChatId = chatId;

      // Register event listeners BEFORE waiting for open — avoids missing
      // events that arrive between onopen and listener registration
      const eventTypes = [
        'thinking', 'text_delta', 'text_done', 'tool_start', 'tool_end',
        'question', 'phase_changed', 'done', 'error',
        // Workspace events (execution/publish lifecycle, chat meta)
        'execution_committed', 'execution_reverted', 'publish_log', 'publish_done',
        'chat_renamed', 'tabs_updated', 'automatism', 'automatism_state', 'chat_archived',
      ];
      for (const type of eventTypes) {
        es.addEventListener(type, (event) => {
          try {
            const data = JSON.parse((event as MessageEvent).data);
            handleServerEvent(type, data);
          } catch (err) {
            console.error('[sse-client] Failed to parse event:', err);
          }
        });
      }

      const wasReconnect = reconnectAttempt > 0;
      await new Promise<void>((resolve) => {
        es.onopen = () => {
          console.log('[sse-client] EventSource connected');
          reconnectAttempt = 0;
          resolve();
        };

        // Also resolve on first error to avoid hanging forever. A fatal
        // first error fires before es.onerror below is assigned — without
        // handling it here the closed EventSource would never retry.
        const errorOnce = () => {
          es.removeEventListener('error', errorOnce);
          if (es.readyState === EventSource.CLOSED) dropAndScheduleReconnect(es);
          resolve();
        };
        es.addEventListener('error', errorOnce);
      });

      es.onerror = () => dropAndScheduleReconnect(es);

      // Events broadcast during the disconnect gap are gone — the server
      // replays only the pending question. Refetch history so the transcript,
      // executions and publish card catch up (server-wins resync).
      if (wasReconnect && es.readyState === EventSource.OPEN) {
        const { resyncChatHistory } = await import('./session');
        void resyncChatHistory(chatId);
      }
    } catch (err) {
      console.error('[sse-client] Failed to connect:', err);
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
};

/**
 * Intentionally close the EventSource (chat switch / sign-out). Suppresses reconnect.
 */
export const disconnectEvents = () => {
  intentionalClose = true;
  connectPromise = null;
  connectedChatId = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
};
