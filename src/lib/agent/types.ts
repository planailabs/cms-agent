/**
 * Agent core types — storage format and turn protocol.
 *
 * Ported from chat/src/lib/chat/handler (Anthropic content blocks) to an
 * OpenAI-compatible shape: assistant messages carry optional tool_calls, tool
 * results are stored as one batch message per round.
 */
import type { TranslatedMessage } from '@/lib/i18n';
import type { DisplayBlock } from '@/lib/messageBlocks';
import type { EditAnnotations } from '@/injected/annotate';
import type OpenAI from 'openai';

/** Turn phase persisted on Chat.turnPhase (same machine as chat/). */
export type TurnPhase = 'idle' | 'running' | 'waiting_for_answer' | 'tool_pending';

/** Workflow phase persisted on Chat.workflowPhase. Reviewing the result is
 *  part of EXECUTE (the old separate PREVIEW phase was merged into it). */
export type WorkflowPhase = 'plan' | 'execute' | 'published';

/** Every phase — for tools available throughout the workflow. */
export const ALL_PHASES: WorkflowPhase[] = ['plan', 'execute', 'published'];

export type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export interface ToolResult {
  toolCallId: string;
  content: string;
}

/** Anchors captured by the preview overlay, attached to user messages. */
export interface PageContext {
  url: string;
  route?: string;
  branch?: string;
  selection?: {
    exact: string;
    prefix?: string;
    suffix?: string;
    cssPath?: string;
  };
  element?: {
    tag: string;
    id?: string;
    classes?: string[];
    headingPath?: string[];
    outerHtmlExcerpt?: string;
  };
  /** Code-browser selection (repo file + line range + snippet). */
  code?: {
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
  };
  /** Pending preview edits carried with this message; not an instruction by itself. */
  editAnnotations?: EditAnnotations;
}

/** Client-safe metadata for a file attached to a user message. */
export interface AttachmentMeta {
  id: string;
  mime: string;
  filename: string;
}

export type StoredMessage =
  | {
      id?: string;
      role: 'user';
      content: string;
      pageContext?: PageContext;
      attachments?: AttachmentMeta[];
      /** Command the message was sent with (lib/commands) — a chip in the UI. */
      command?: string;
      /** Things this message SHOWS (lib/messageBlocks). The model reads
       *  `content`; blocks are for the person looking at the transcript. */
      blocks?: DisplayBlock[];
    }
  // `blocks` and `toolCalls` are mutually exclusive in practice — they share
  // one column, and only the guard-rail endings (turnNotices) carry blocks.
  | { id?: string; role: 'assistant'; content: string; toolCalls?: ToolCall[]; blocks?: DisplayBlock[] }
  | { id?: string; role: 'tool'; results: ToolResult[] }
  // `tm` localizes server-written notes per viewer (content is the English
  // fallback); rows the browser writes leave it unset.
  | { id?: string; role: 'cancel'; content: string; tm?: TranslatedMessage }
  // Durable boundary for model context. Older rows stay in the DB, but future
  // loads begin at this summary instead of replaying the entire transcript.
  | { id?: string; role: 'compaction'; content: string }
  // Agent-less flow event (see lib/automatism.ts) — part of the agent context
  | { id?: string; role: 'automatism'; content: string };

export interface ClientToolPrompt {
  toolName: string;
  input: Record<string, unknown>;
}

/** Sent by the browser with every POST /api/chat/message. */
export interface IncomingChatMessage {
  chatId: string;
  /** 'continue' resumes an interrupted/failed turn from stored state. */
  type: 'message' | 'answer' | 'continue';
  text: string;
  /** Current browser locale for this request only; never persisted. */
  uiLocale?: 'en' | 'de';
  pageContext?: PageContext;
  /** Ids of uploads (chat-scoped) attached to this message. */
  attachmentIds?: string[];
  /** Command parsed off the text by the endpoint (lib/commands). */
  command?: string;
  /** What the message SHOWS in the transcript (lib/messageBlocks). Server-set
   *  only — the browser sends none of these. */
  blocks?: DisplayBlock[];
}
