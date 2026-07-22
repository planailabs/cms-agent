/**
 * Message utilities — conversion to OpenAI chat messages, sanitization,
 * trimming. Ported from chat/'s messageUtils.ts (Anthropic → OpenAI shapes;
 * prompt-cache breakpoints dropped: OpenAI-compatible APIs cache implicitly).
 */
import type OpenAI from 'openai';
import type { PageContext, StoredMessage } from './types';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ─── Context injection ───────────────────────────────────────────────────────

/** Render the [User context] block prepended to user messages (plan §2). */
export function renderPageContext(ctx: PageContext): string {
  const lines: string[] = ['[User context]'];
  lines.push(`Currently viewing: ${ctx.url}${ctx.route ? ` (route ${ctx.route})` : ''}`);
  if (ctx.branch) lines.push(`Preview branch: ${ctx.branch}`);
  if (ctx.selection) {
    lines.push(`Selected text: "${ctx.selection.exact}"`);
    if (ctx.selection.cssPath) lines.push(`Selection CSS path: ${ctx.selection.cssPath}`);
  }
  if (ctx.element) {
    const el = ctx.element;
    lines.push(
      `Selected element: <${el.tag}${el.id ? ` id="${el.id}"` : ''}${
        el.classes?.length ? ` class="${el.classes.join(' ')}"` : ''
      }>`,
    );
    if (el.headingPath?.length) lines.push(`Element heading path: ${el.headingPath.join(' > ')}`);
    if (el.outerHtmlExcerpt) lines.push(`Element excerpt: ${el.outerHtmlExcerpt}`);
  }
  if (ctx.code) {
    lines.push(
      `Code selection: ${ctx.code.path} lines ${ctx.code.startLine}-${ctx.code.endLine}:`,
      '```',
      ctx.code.snippet,
      '```',
    );
  }
  return lines.join('\n');
}

// ─── Conversion ──────────────────────────────────────────────────────────────

/**
 * Convert StoredMessage[] → OpenAI message params. 'cancel' rows are display
 * only; tool batches expand to one `tool` message per result.
 */
export const toOpenAiMessages = (msgs: StoredMessage[]): ChatMessage[] => {
  const result: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'cancel') continue;
    if (m.role === 'compaction') {
      result.push({ role: 'user', content: `[Conversation summary]\n${m.content}` });
    } else if (m.role === 'automatism') {
      // Agent-less flow events: model context, marked as such
      result.push({ role: 'user', content: `[Automatism]\n${m.content}` });
    } else if (m.role === 'user') {
      const text = m.pageContext ? `${renderPageContext(m.pageContext)}\n\n${m.content}` : m.content;
      result.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls } : {}),
      });
    } else {
      for (const r of m.results) {
        result.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      }
    }
  }
  return result;
};

// ─── Sanitization ────────────────────────────────────────────────────────────

/**
 * Strip assistant tool_calls that don't have matching tool messages
 * immediately following (interrupted turns would otherwise 400 the API).
 */
export const sanitizeMessages = (msgs: ChatMessage[]): ChatMessage[] => {
  const result: ChatMessage[] = [];
  // tool_call ids of the most recent kept assistant message that still expect results
  let openCallIds = new Set<string>();

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];

    if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls?.length) {
      const resultIds = new Set<string>();
      for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) {
        resultIds.add((msgs[j] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam).tool_call_id);
      }
      if (msg.tool_calls.every((c) => resultIds.has(c.id))) {
        openCallIds = new Set(msg.tool_calls.map((c) => c.id));
        result.push(msg);
      } else {
        // Interrupted turn: keep the text, drop the calls (and their results)
        openCallIds = new Set();
        if (msg.content) result.push({ role: 'assistant', content: msg.content });
      }
      continue;
    }

    if (msg.role === 'tool') {
      if (openCallIds.has(msg.tool_call_id)) result.push(msg);
      continue;
    }

    openCallIds = new Set();
    result.push(msg);
  }
  return result;
};

// ─── Size helpers + trimming (same chunking strategy as chat/) ───────────────

export const hasToolCalls = (msg: StoredMessage): boolean =>
  msg.role === 'assistant' && !!msg.toolCalls?.length;

export const isToolResultMsg = (msg: StoredMessage): boolean => msg.role === 'tool';

/** Plain transcript for the summarizer; this never replaces persisted rows. */
export const compactionTranscript = (msgs: StoredMessage[], maxChars = 120_000): string => {
  const rendered = msgs
    .filter((msg) => msg.role !== 'cancel')
    .map((msg) => {
      if (msg.role === 'tool') {
        return `[tool results]\n${msg.results.map((r) => r.content).join('\n')}`;
      }
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const calls = msg.toolCalls
          .map((call) => `${call.function.name}(${call.function.arguments})`)
          .join('\n');
        return `[assistant]\n${msg.content}\n[tool calls]\n${calls}`;
      }
      return `[${msg.role}]\n${msg.content}`;
    })
    .join('\n\n');
  if (rendered.length <= maxChars) return rendered;
  // Keep the original request plus the largest possible recent tail.
  const marker = '\n\n[older transcript elided for summarization]\n\n';
  const contentBudget = Math.max(0, maxChars - marker.length);
  const headLength = Math.min(20_000, Math.floor(contentBudget / 3));
  const head = rendered.slice(0, headLength);
  const tailLength = contentBudget - headLength;
  const tail = tailLength > 0 ? rendered.slice(-tailLength) : '';
  return `${head}${marker}${tail}`;
};

// ─── Tool call helpers ───────────────────────────────────────────────────────

/** Tool calls of the last assistant message, if it is the latest message group. */
export const getLastToolCalls = (messages: StoredMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      return msg.toolCalls && msg.toolCalls.length > 0 ? msg.toolCalls : null;
    }
    if (msg.role === 'user') break;
  }
  return null;
};
