/**
 * Agent core types — storage format and turn protocol.
 *
 * Ported from chat/src/lib/chat/handler (Anthropic content blocks) to an
 * OpenAI-compatible shape: assistant messages carry optional tool_calls, tool
 * results are stored as one batch message per round.
 */
import type OpenAI from 'openai';

/** Turn phase persisted on Chat.turnPhase (same machine as chat/). */
export type TurnPhase = 'idle' | 'running' | 'waiting_for_answer' | 'tool_pending';

/** Workflow phase persisted on Chat.workflowPhase. */
export type WorkflowPhase = 'plan' | 'execute' | 'preview' | 'published';

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
}

/** Client-safe metadata for a file attached to a user message. */
export interface AttachmentMeta {
  id: string;
  mime: string;
  filename: string;
}

export type StoredMessage =
  | { id?: string; role: 'user'; content: string; pageContext?: PageContext; attachments?: AttachmentMeta[] }
  | { id?: string; role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { id?: string; role: 'tool'; results: ToolResult[] }
  | { id?: string; role: 'cancel'; content: string }
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
  pageContext?: PageContext;
  /** Ids of uploads (chat-scoped) attached to this message. */
  attachmentIds?: string[];
}
