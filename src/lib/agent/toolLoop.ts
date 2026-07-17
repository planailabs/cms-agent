/**
 * The session loop — ported from chat/src/lib/chat/handler/toolLoop.ts.
 * Anthropic streaming → OpenAI chat.completions streaming; tools dispatched
 * through the in-process MCP bridge; same resumable turn-phase machine:
 *   idle → (rounds of tool calls) → waiting_for_answer | tool_pending → idle
 */
import OpenAI from 'openai';
import { env } from '@/lib/env';
import { broadcast } from './bus';
import { getLastToolCalls, sanitizeMessages, toOpenAiMessages, trimMessages } from './messageUtils';
import type { PersistenceAdapter } from './persistence';
import { recordTokenUsage } from './tokenBudget';
import { buildSystemPrompt, type PromptInput } from './prompt';
import { createMcpBridge } from './mcp';
import { isClientSideTool, type ToolContext } from './tools/registry';
import type { ClientToolPrompt, StoredMessage, ToolCall, ToolResult, TurnPhase } from './types';

const MAX_TOOL_ROUNDS = 250;
const LOOP_WINDOW = 5;
const LOOP_THRESHOLD = 3;

/** Key-order-independent canonical form of tool arguments. */
function canonicalArgs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalArgs).join(',')}]`;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalArgs(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Detects tool-call loops: the same tool called with identical arguments
 * LOOP_THRESHOLD times within the last LOOP_WINDOW calls. The sliding window
 * catches both straight repeats and A-B-A-B alternation while leaving
 * legitimate re-reads (interleaved with other work) alone.
 */
export function createLoopDetector(): (name: string, args: unknown) => string | null {
  const recent: string[] = [];
  return (name, args) => {
    const key = `${name}:${canonicalArgs(args)}`;
    recent.push(key);
    if (recent.length > LOOP_WINDOW) recent.shift();
    const count = recent.filter((k) => k === key).length;
    if (count < LOOP_THRESHOLD) return null;
    return JSON.stringify({
      error:
        `Loop detected: "${name}" was called with identical arguments ${count} times ` +
        `in the last ${recent.length} tool calls. The call was NOT executed — its result ` +
        `would not change. Take a different approach, change the arguments, or ask the ` +
        `user for guidance.`,
    });
  };
}

/**
 * Build tool results after a client-side tool pause was answered/cancelled.
 * The client tool call gets the user's answer; any parallel calls are marked
 * skipped (mirrors chat/'s buildQuestionToolResults).
 */
export function buildQuestionToolResults(
  toolCalls: ToolCall[],
  clientCallId: string,
  answer: string,
  cancelled: boolean,
): ToolResult[] {
  return toolCalls.map((call) => {
    if (call.id === clientCallId) {
      return {
        toolCallId: call.id,
        content: cancelled ? 'The user cancelled the question.' : `User answered: ${answer}`,
      };
    }
    return {
      toolCallId: call.id,
      content: 'Skipped: a user question interrupted this tool call. Re-issue it if still needed.',
    };
  });
}

export interface ToolLoopInput {
  chatId: string;
  userId: string;
  messages: StoredMessage[];
  phase: TurnPhase;
  toolContext: ToolContext;
  promptInput: PromptInput;
  setPhase: (phase: TurnPhase, pendingQuestion?: ClientToolPrompt | null) => Promise<void>;
  appendMsg: (msg: StoredMessage) => Promise<void>;
  skipTokenAccounting?: boolean;
}

export async function runToolLoop(input: ToolLoopInput): Promise<void> {
  const e = env();
  const { chatId, messages, toolContext, setPhase, appendMsg } = input;

  const openai = new OpenAI({ baseURL: e.OPENAI_BASE_URL, apiKey: e.OPENAI_API_KEY });
  const bridge = await createMcpBridge(toolContext);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const flushTokens = async () => {
    if (!input.skipTokenAccounting && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      await recordTokenUsage(input.userId, chatId, totalInputTokens, totalOutputTokens);
      totalInputTokens = 0;
      totalOutputTokens = 0;
    }
  };

  try {
    const tools = await bridge.asOpenAiTools();
    const systemPrompt = buildSystemPrompt(input.promptInput);
    const detectLoop = createLoopDetector();

    // ── Pre-step: resume from tool_pending (crash/restart recovery) ─────────
    if (input.phase === 'tool_pending') {
      broadcast(chatId, 'thinking', { type: 'thinking' });
      const toolCalls = getLastToolCalls(messages);
      if (!toolCalls) throw new Error('Resume error: no pending tool calls found');

      const results: ToolResult[] = [];
      for (const call of toolCalls) {
        if (isClientSideTool(call.function.name)) continue;
        const args = safeParseArgs(call.function.arguments);
        broadcast(chatId, 'tool_start', { type: 'tool_start', name: call.function.name, input: args });
        const content = await bridge.callTool(call.function.name, args);
        results.push({ toolCallId: call.id, content });
        broadcast(chatId, 'tool_end', {
          type: 'tool_end',
          name: call.function.name,
          result: content.slice(0, 2000),
        });
      }
      await appendMsg({ role: 'tool', results });
      await setPhase('idle');
    }

    // ── Main loop ────────────────────────────────────────────────────────────
    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const trimmed = trimMessages(messages.filter((m) => m.role !== 'cancel'));
      const chatMessages = sanitizeMessages(toOpenAiMessages(trimmed));

      console.log(`[agent] chat=${chatId} round ${rounds}/${MAX_TOOL_ROUNDS}, ${chatMessages.length} msgs`);
      broadcast(chatId, 'thinking', { type: 'thinking' });

      const stream = openai.beta.chat.completions.stream({
        model: e.OPENAI_MODEL,
        max_tokens: e.OPENAI_MAX_TOKENS,
        messages: [{ role: 'system', content: systemPrompt }, ...chatMessages],
        tools: tools.length > 0 ? tools : undefined,
        stream_options: { include_usage: true },
      });

      stream.on('content', (delta: string) => {
        broadcast(chatId, 'text_delta', { type: 'text_delta', content: delta });
      });

      const completion = await stream.finalChatCompletion();
      const choice = completion.choices[0];
      const message = choice.message;

      if (completion.usage) {
        totalInputTokens += completion.usage.prompt_tokens ?? 0;
        totalOutputTokens += completion.usage.completion_tokens ?? 0;
      }

      const text = message.content ?? '';
      const toolCalls = (message.tool_calls ?? []) as ToolCall[];
      console.log(`[agent] finish=${choice.finish_reason}, ${toolCalls.length} tools`);

      if (text) broadcast(chatId, 'text_done', { type: 'text_done', content: text });

      // ── Final response ─────────────────────────────────────────────────────
      if (toolCalls.length === 0) {
        if (text) await appendMsg({ role: 'assistant', content: text });
        await setPhase('idle');
        broadcast(chatId, 'done', { type: 'done' });
        await flushTokens();
        return;
      }

      // Store full assistant response including tool calls
      await appendMsg({ role: 'assistant', content: text, toolCalls });

      // ── Client-side tool → pause for the browser ──────────────────────────
      const clientCall = toolCalls.find((c) => isClientSideTool(c.function.name));
      if (clientCall) {
        rounds--; // questions don't count as tool rounds
        const prompt: ClientToolPrompt = {
          toolName: clientCall.function.name,
          input: safeParseArgs(clientCall.function.arguments),
        };
        // Persist phase BEFORE broadcasting — resumable checkpoint
        await setPhase('waiting_for_answer', prompt);
        broadcast(chatId, 'question', {
          type: 'question',
          toolName: prompt.toolName,
          input: prompt.input,
        });
        await flushTokens();
        return;
      }

      // ── Server-side tools ──────────────────────────────────────────────────
      await setPhase('tool_pending');
      const results: ToolResult[] = [];
      for (const call of toolCalls) {
        const args = safeParseArgs(call.function.arguments);
        broadcast(chatId, 'tool_start', { type: 'tool_start', name: call.function.name, input: args });
        const loopWarning = detectLoop(call.function.name, args);
        if (loopWarning) console.warn(`[agent] chat=${chatId} loop detected on ${call.function.name}`);
        const content = loopWarning ?? (await bridge.callTool(call.function.name, args));
        results.push({ toolCallId: call.id, content });
        broadcast(chatId, 'tool_end', {
          type: 'tool_end',
          name: call.function.name,
          result: content.slice(0, 2000),
        });
      }
      await appendMsg({ role: 'tool', results });
      await setPhase('idle');
    }

    // ── Max rounds reached ─────────────────────────────────────────────────
    const msg =
      "I've been working on your request but it required too many steps. Could you try a more specific request?";
    await appendMsg({ role: 'assistant', content: msg });
    await setPhase('idle');
    broadcast(chatId, 'text_done', { type: 'text_done', content: msg });
    broadcast(chatId, 'done', { type: 'done' });
    await flushTokens();
  } finally {
    await flushTokens();
    await bridge.close();
  }
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
