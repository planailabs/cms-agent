/**
 * Chat Events — SSE event dispatcher (handleServerEvent).
 */

import { store } from '../../app/store';
import type { WorkflowPhase } from '../../app/state';
import { t, uiLocale, type TranslatedMessage } from '@/lib/i18n';
import { cacheAIChatMessages } from './cache';
import { transition } from './stateMachine';
import { publishCardReducer } from '../../../workspace/publishCard';
import { createInitialDiffState } from '../../../workspace/state';
import { onRemoteTabsUpdated } from '../../../workspace/tabsSync';

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

    case 'execution_committed': {
      const sha = data.sha as string;
      const summary = (data.summary as string) ?? '';
      if (!ws.executions.some((e) => e.sha === sha)) {
        ws.executions.push({ sha, summary });
      }
      ws.executionSha = sha;
      // Anchor the card inline at its chronological place in the transcript
      const mc = store.state.chat?.aiChat;
      if (mc && !mc.messages.some((m) => m.role === 'execution' && m.sha === sha)) {
        mc.messages.push({ role: 'execution', content: '', sha });
        cacheAIChatMessages(mc.messages);
      }
      store.notify();
      return true;
    }

    case 'tabs_updated': {
      onRemoteTabsUpdated(data);
      return true;
    }

    case 'chat_renamed': {
      const chatId = data.chatId as string;
      const title = data.title as string;
      if (chatId && title) {
        for (const branch of store.state.branches) {
          const chat = branch.chats.find((c) => c.id === chatId);
          if (chat) chat.title = title;
        }
        store.notify();
      }
      return true;
    }

    case 'execution_reverted': {
      const sha = data.sha as string;
      const revertSha = data.revertSha as string;
      const by = (data.by as string) ?? '';
      const card = ws.executions.find((e) => e.sha === sha);
      if (card) {
        card.reverted = { revertSha, by };
        card.busy = false;
      }
      // A reverted sha must not be published
      if (ws.executionSha === sha) ws.executionSha = null;
      store.notify();
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

    case 'automatism_state': {
      // Step-bar progress for the active chat's automatism
      if (data.chatId === store.state.activeChatId) {
        store.state.workspace.automatism = {
          forChatId: data.chatId as string,
          automatismType: (data.automatismType as string) ?? '',
          status: (data.status as string) ?? 'running',
          step: (data.step as number) ?? 0,
          steps: (data.steps as string[]) ?? [],
          lastError: (data.lastError as string | null) ?? null,
        };
        // A finished sync means the draft now contains the target
        if (data.automatismType === 'pull' && data.status === 'done') {
          ws.targetAhead = false;
        }
        store.notify();
      }
      return true;
    }

    case 'chat_archived': {
      // Done chats leave the sidebar (they live in the archive view now)
      const chatId = data.chatId as string;
      for (const branch of store.state.branches) {
        const idx = branch.chats.findIndex((c) => c.id === chatId);
        if (idx >= 0) branch.chats.splice(idx, 1);
      }
      // Still open? Swap the composer for the archived note right away.
      if (chatId === store.state.activeChatId) {
        store.state.activeChatArchived = true;
      }
      store.notify();
      return true;
    }

    case 'publish_done': {
      ws.publish = publishCardReducer(ws.publish, {
        type: 'done',
        publicationId: data.publicationId as string,
        ok: Boolean(data.ok),
        sha: data.sha as string | undefined,
        error: data.error as string | undefined,
        externalUrl: data.externalUrl as string | undefined,
      });
      store.notify();
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
const TRANSCRIPT_EVENTS = new Set(['text_delta', 'text_done', 'tool_start', 'tool_end']);

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
      const mc2 = store.state.chat?.aiChat;
      if (mc2) {
        mc2.messages.push({ role: 'assistant', content });
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
      // Finalize any pending streaming text before showing question
      if (mc2.streamingText?.full) {
        mc2.messages.push({ role: 'assistant', content: mc2.streamingText.full });
      }
      mc2.streamingText = undefined;

      const toolName = data.toolName as string;
      const input = data.input as Record<string, unknown>;

      // Generic: store the prompt
      mc2.phase = 'question';
      mc2.clientPrompt = { toolName, input };
      mc2.toolName = undefined;

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

    case 'phase_changed': {
      const workflowPhase = data.workflowPhase as WorkflowPhase;
      store.state.workflowPhase = workflowPhase;
      // Keep the branch list summary in sync with the active chat
      const activeChatId = store.state.activeChatId;
      for (const branch of store.state.branches) {
        const chat = branch.chats.find((c) => c.id === activeChatId);
        if (chat) chat.workflowPhase = workflowPhase;
      }
      // Workspace: remember the reviewed sha (used by the Publish action) and
      // reset the diff viewer so it reloads on (re-)entering PREVIEW.
      const ws = store.state.workspace;
      if (typeof data.executionSha === 'string' && data.executionSha) {
        ws.executionSha = data.executionSha;
      }
      ws.diff = createInitialDiffState();
      // A new plan round (request changes after a publish) — the previous
      // round's publish card no longer describes the draft.
      if (workflowPhase === 'plan') ws.publish = null;
      store.notify();
      break;
    }

    case 'done': {
      const mc2 = store.state.chat?.aiChat;
      if (mc2) {
        // Finalize any pending streaming text that wasn't closed by text_done
        if (mc2.streamingText?.full) {
          mc2.messages.push({ role: 'assistant', content: mc2.streamingText.full });
          mc2.streamingText = undefined;
        }
        mc2.phase = 'idle';
        mc2.toolName = undefined;
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
