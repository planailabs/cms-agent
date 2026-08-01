/**
 * Chat Events — SSE event dispatcher (handleServerEvent).
 */

import { store } from '../../app/store';
import { t, uiLocale, type TranslatedMessage } from '@/lib/i18n';
import { cacheAIChatMessages } from './cache';
import { transition } from './stateMachine';
import { publishCardReducer } from '../../../workspace/publishCard';
import { applyTransientUiLanguage } from './transientLocale';
import { applyOpenCompare } from './openCompare';
import { applyCompareStale } from '../../../workspace/compareStale';
import { normalizeBlocks } from '@/lib/messageBlocks';

/**
 * Handles workspace-level events (execution/publish lifecycle). These don't
 * need chat state, so they run before the aiChat guard.
 * Returns true when the event was consumed.
 */
const handleWorkspaceEvent = (type: string, data: Record<string, unknown>): boolean => {
  const ws = store.state.workspace;

  switch (type) {
    case 'state': {
      // Streamed-state phase 1: full server snapshot, applied by replacement
      // (legacy events below still run — they set the same values).
      if (data.state) {
        void import('./session').then(({ applyChatState }) =>
          applyChatState(
            data.state as import('./session').ChatStateSnapshot,
            data.clientId as string | undefined,
          ),
        );
      }
      return true;
    }

    case 'ui_language':
      // Deliberate SSE-only exception: do not cache, persist, or add to chat state.
      applyTransientUiLanguage(data.locale, data.userId);
      return true;

    case 'open_compare':
      // Same live-nudge contract as ui_language: no cache, no replay.
      applyOpenCompare(data.mode, data.userId, data.chatId);
      return true;

    case 'compare_stale':
      // The agent touched the site, so the shots on screen are of a page that
      // no longer exists. Refetch if someone is looking; otherwise mark it, so
      // opening the compare window loads the new state instead of the cache.
      applyCompareStale(data.generation);
      return true;

    case 'execution_committed': {
      // Transcript-anchor event: the card's chronological place in the LIVE
      // transcript. Its state part (ws.executions/executionSha) comes from
      // the `state` snapshot that follows it.
      const sha = data.sha as string;
      const mc = store.state.chat?.aiChat;
      if (mc && !mc.messages.some((m) => m.role === 'execution' && m.sha === sha)) {
        mc.messages.push({ role: 'execution', content: '', sha });
        cacheAIChatMessages(mc.messages);
        store.notify();
      }
      return true;
    }

    case 'publish_log': {
      ws.publish = publishCardReducer(ws.publish, {
        type: 'log',
        publicationId: data.publicationId as string,
        line: (data.line as string) ?? '',
      });
      store.notify();
      return true;
    }

    case 'automatism': {
      // Agent-less flow event — appended to the transcript of the open chat
      const mc = store.state.chat?.aiChat;
      if (mc) {
        mc.messages.push({
          role: 'automatism',
          content: (data.content as string) ?? '',
          ...(data.tm ? { tm: data.tm as TranslatedMessage } : {}),
        });
        cacheAIChatMessages(mc.messages);
        store.notify();
      }
      return true;
    }

  }
  return false;
};

/** Monotonic count of live transcript-mutating events (active-turn stream).
 *  applyHistory compares it against its fetch-start snapshot: if the stream
 *  advanced meanwhile, the fetched history is older than the screen. */
let transcriptEventSeq = 0;
export const getTranscriptEventSeq = (): number => transcriptEventSeq;
const TRANSCRIPT_EVENTS = new Set([
  'text_delta',
  'text_done',
  'tool_start',
  'tool_end',
  'compaction',
]);

/**
 * Handles all server → client events from the SSE stream.
 */
export const handleServerEvent = (type: string, data: Record<string, unknown>) => {
  console.log('[sse-client] Received:', type);
  if (TRANSCRIPT_EVENTS.has(type)) transcriptEventSeq++;

  if (handleWorkspaceEvent(type, data)) return;

  const currentMc = store.state.chat?.aiChat;
  if (!currentMc) {
    console.warn('[sse-client] No aiChat in state, ignoring');
    return;
  }

  switch (type) {
    case 'compaction_start':
      transition(currentMc, 'compacting');
      store.notify();
      break;

    case 'compaction':
      currentMc.messages.push({
        role: 'compaction',
        content: (data.content as string) ?? '',
      });
      cacheAIChatMessages(currentMc.messages);
      store.notify();
      break;

    case 'thinking':
      transition(currentMc, 'waiting');
      store.notify();
      break;

    case 'text_delta': {
      const content: string = data.content as string;
      if (currentMc.phase !== 'streaming') {
        transition(currentMc, 'streaming');
        currentMc.streamingText = { full: '', visible: '' };
      }
      currentMc.streamingText!.full += content;
      currentMc.streamingText!.visible += content;
      store.notify();
      break;
    }

    case 'text_done': {
      const content: string = data.content as string;
      // A turn that ended against a guard rail sends its card with the text
      // (lib/agent/turnNotices) — without this the card only appears on reload.
      const blocks = normalizeBlocks(data.blocks ? { v: 1, blocks: data.blocks } : null);
      const mc2 = store.state.chat?.aiChat;
      if (mc2) {
        mc2.messages.push({ role: 'assistant', content, ...(blocks.length ? { blocks } : {}) });
        mc2.streamingText = undefined;
        cacheAIChatMessages(mc2.messages);
        store.notify();
      }
      break;
    }

    case 'tool_start': {
      transition(currentMc, 'tool');
      currentMc.toolName = data.name as string;
      // Persistent, collapsible tool-call row in the transcript
      currentMc.messages.push({
        role: 'tool',
        content: '',
        tool: { name: data.name as string, input: data.input, running: true },
      });
      store.notify();
      break;
    }

    case 'tool_end': {
      transition(currentMc, 'waiting');
      const name = data.name as string;
      for (let i = currentMc.messages.length - 1; i >= 0; i--) {
        const msg = currentMc.messages[i];
        if (msg.role === 'tool' && msg.tool?.running && msg.tool.name === name) {
          msg.tool.running = false;
          msg.tool.result = data.result as string | undefined;
          break;
        }
      }
      cacheAIChatMessages(currentMc.messages);
      store.notify();
      break;
    }

    case 'question': {
      const mc2 = store.state.chat?.aiChat;
      if (!mc2) return;
      const toolName = data.toolName as string;
      const input = data.input as Record<string, unknown>;

      // One place decides what leaving a phase means: finalize streamed text,
      // drop transient state, cancel a pending tool→waiting timer. Doing it
      // by hand here is how the two drift.
      transition(mc2, 'question');
      mc2.clientPrompt = { toolName, input }; // transition() clears it first

      // Tool-specific initialization
      if (toolName === 'ask_question') {
        // Backwards compat: add question text to messages (existing behavior)
        const q = input as { question: string };
        const lastMsg = mc2.messages[mc2.messages.length - 1];
        if (!(lastMsg?.role === 'assistant' && lastMsg.content === q.question)) {
          mc2.messages.push({ role: 'assistant', content: q.question });
        }
      }

      cacheAIChatMessages(mc2.messages);
      store.notify();
      break;
    }

    case 'stopped': {
      // The turn ended because the user asked it to: mirror the note the
      // server persisted, so the transcript reads the same before and after a
      // reload. 'done' follows and settles the phase.
      const mc2 = store.state.chat?.aiChat;
      if (mc2) {
        mc2.stopping = false;
        if (mc2.streamingText?.full) {
          mc2.messages.push({ role: 'assistant', content: mc2.streamingText.full });
          mc2.streamingText = undefined;
        }
        mc2.messages.push({ role: 'cancel', content: t(uiLocale(), 'chat.stopped') });
        cacheAIChatMessages(mc2.messages);
        store.notify();
      }
      break;
    }

    case 'done': {
      const mc2 = store.state.chat?.aiChat;
      if (mc2) {
        // Same edge as every other ending, including text the stream never
        // closed and a tool→waiting timer that must not fire after the turn.
        transition(mc2, 'idle');
        cacheAIChatMessages(mc2.messages);
        store.notify();
      }
      break;
    }

    case 'error':
      transition(currentMc, 'error');
      currentMc.error = (data.message as string) ?? t(uiLocale(), 'chat.error.generic');
      store.notify();
      break;
  }
};
