/**
 * The session loop — ported from chat/src/lib/chat/handler/toolLoop.ts.
 * Anthropic streaming → OpenAI chat.completions streaming; tools dispatched
 * through the in-process MCP bridge; same resumable turn-phase machine:
 *   idle → (rounds of tool calls) → waiting_for_answer | tool_pending → idle
 */
import fs from 'node:fs';
import OpenAI from 'openai';
import { env } from '@/lib/env';
import { prisma } from '@/lib/db';
import { broadcast } from './bus';
import {
  compactionTranscript,
  getLastToolCalls,
  sanitizeMessages,
  toOpenAiMessages,
  type ImageResolver,
} from './messageUtils';
import type { PersistenceAdapter } from './persistence';
import { recordTokenUsage } from './tokenBudget';
import { buildSystemPrompt, type PromptInput } from './prompt';
import { createMcpBridge } from './mcp';
import { dirStatus } from '@/lib/git/engine';
import { isClientSideTool, type ToolContext } from './tools/registry';
import type { ClientToolPrompt, StoredMessage, ToolCall, ToolResult, TurnPhase } from './types';

const MAX_TOOL_ROUNDS = 250;
const LOOP_WINDOW = 5;
const LOOP_THRESHOLD = 3;

export const isContextLengthError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; type?: unknown; message?: unknown };
  if (value.code === 'context_length_exceeded' || value.type === 'context_length_exceeded') {
    return true;
  }
  return (
    typeof value.message === 'string' &&
    /maximum context length|context window|too many tokens/i.test(value.message)
  );
};

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

  // Preload image attachments so an image read_upload can be inlined as a
  // multimodal message (Chat Completions can't carry images in tool results;
  // see toOpenAiMessages). Bytes are read lazily, only for images the agent
  // actually reads.
  const imageIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'user' && m.attachments) {
      for (const a of m.attachments) if (a.mime.startsWith('image/')) imageIds.add(a.id);
    }
  }
  let resolveImage: ImageResolver | undefined;
  if (imageIds.size > 0) {
    const ups = await prisma.upload.findMany({
      where: { id: { in: [...imageIds] } },
      select: { id: true, mime: true, storedPath: true },
    });
    const byId = new Map(ups.map((u) => [u.id, u]));
    resolveImage = (uploadId) => {
      const u = byId.get(uploadId);
      if (!u) return null;
      try {
        const b = fs.readFileSync(u.storedPath);
        return { mime: u.mime, dataUrl: `data:${u.mime};base64,${b.toString('base64')}` };
      } catch {
        return null;
      }
    };
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let activeContextTokens = 0;

  const flushTokens = async () => {
    if (!input.skipTokenAccounting && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      await recordTokenUsage(input.userId, chatId, totalInputTokens, totalOutputTokens);
      totalInputTokens = 0;
      totalOutputTokens = 0;
    }
  };

  try {
    const tools = await bridge.asOpenAiTools();
    const systemPrompt = buildSystemPrompt({ ...input.promptInput, mcpHints: bridge.promptHints() });
    const detectLoop = createLoopDetector();
    let compactedForRequest = false;

    const compactContext = async (): Promise<void> => {
      broadcast(chatId, 'compaction_start', { type: 'compaction_start' });
      let maxChars = 120_000;
      let compacted: OpenAI.Chat.Completions.ChatCompletion;
      for (;;) {
        try {
          compacted = await openai.chat.completions.create({
            model: e.OPENAI_MODEL,
            max_tokens: Math.min(2048, e.OPENAI_MAX_TOKENS),
            messages: [
              {
                role: 'system',
                content:
                  'Summarize this CMS agent conversation for another agent that must continue the work. ' +
                  'Preserve user requirements, decisions, current task state, completed work, file paths, ' +
                  'commands and test results, unresolved errors, and exact next steps. Do not add advice or ' +
                  `invent facts. Write in locale ${input.promptInput.locale}.`,
              },
              { role: 'user', content: compactionTranscript(messages, maxChars) },
            ],
          });
          break;
        } catch (error) {
          if (!isContextLengthError(error) || maxChars <= 8_000) throw error;
          maxChars = Math.max(8_000, Math.floor(maxChars / 2));
        }
      }
      totalInputTokens += compacted.usage?.prompt_tokens ?? 0;
      totalOutputTokens += compacted.usage?.completion_tokens ?? 0;
      const summary = compacted.choices[0]?.message.content?.trim();
      if (!summary) throw new Error('Context compaction returned an empty summary');
      const checkpoint: StoredMessage = { role: 'compaction', content: summary };
      await appendMsg(checkpoint);
      // Persistence retains every old row. Only the model-facing in-memory
      // window advances to the durable checkpoint.
      messages.splice(0, messages.length, checkpoint);
      activeContextTokens = 0;
      broadcast(chatId, 'compaction', { type: 'compaction', content: summary });
    };

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
      await setPhase('running');
    } else {
      // A durable active-turn marker makes a model request interrupted by a
      // server restart distinguishable from a completed idle conversation.
      await setPhase('running');
    }

    // ── Main loop ────────────────────────────────────────────────────────────
    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const chatMessages = sanitizeMessages(
        toOpenAiMessages(messages.filter((m) => m.role !== 'cancel'), resolveImage),
      );

      // Route to the vision model when the context now contains an image part.
      const usesVision = chatMessages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((p) => (p as { type?: string }).type === 'image_url'),
      );
      const model = usesVision && e.OPENAI_VISION_MODEL ? e.OPENAI_VISION_MODEL : e.OPENAI_MODEL;

      console.log(`[agent] chat=${chatId} round ${rounds}/${MAX_TOOL_ROUNDS}, ${chatMessages.length} msgs`);
      broadcast(chatId, 'thinking', { type: 'thinking' });

      // Hand-accumulated streaming: the SDK's beta stream helper rejects
      // slightly nonconforming chunks ("missing role for choice 0") that
      // OpenAI-compatible backends emit on edge cases (empty completions,
      // usage-only streams). Accumulate leniently ourselves instead.
      let text = '';
      let finishReason: string | null = null;
      const accumulated: ToolCall[] = [];
      try {
        const stream = await openai.chat.completions.create({
          model,
          max_tokens: e.OPENAI_MAX_TOKENS,
          messages: [{ role: 'system', content: systemPrompt }, ...chatMessages],
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true },
        });

        for await (const chunk of stream) {
          if (chunk.usage) {
            const promptTokens = chunk.usage.prompt_tokens ?? 0;
            totalInputTokens += promptTokens;
            totalOutputTokens += chunk.usage.completion_tokens ?? 0;
            if (promptTokens > 0) activeContextTokens = promptTokens;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          finishReason = choice.finish_reason ?? finishReason;
          const delta = choice.delta ?? {};
          if (delta.content) {
            text += delta.content;
            broadcast(chatId, 'text_delta', { type: 'text_delta', content: delta.content });
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? accumulated.length;
            accumulated[idx] ??= {
              id: tc.id ?? `call_${idx}`,
              type: 'function',
              function: { name: '', arguments: '' },
            };
            if (tc.id) accumulated[idx].id = tc.id;
            // Assign, don't concatenate: some backends (codex proxy) repeat the
            // FULL name on every fragment; only arguments stream incrementally.
            if (tc.function?.name) accumulated[idx].function.name = tc.function.name;
            if (tc.function?.arguments) {
              accumulated[idx].function.arguments = accumulateArgs(
                accumulated[idx].function.arguments,
                tc.function.arguments,
              );
            }
          }
        }
      } catch (error) {
        if (
          !isContextLengthError(error) ||
          compactedForRequest ||
          text.length > 0 ||
          accumulated.length > 0
        ) {
          throw error;
        }
        console.log(
          `[agent] chat=${chatId} context limit reached for model=${e.OPENAI_MODEL}` +
            (activeContextTokens > 0 ? ` after ${activeContextTokens} prompt tokens` : ''),
        );
        await compactContext();
        compactedForRequest = true;
        rounds--;
        continue;
      }

      compactedForRequest = false;

      const toolCalls = accumulated.filter(Boolean);
      console.log(
        `[agent] finish=${finishReason}, ${toolCalls.length} tools, context=${activeContextTokens} tokens`,
      );

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

      // ── finish_execution gate: every change must be committed first ───────
      const finishCall = toolCalls.find((c) => c.function.name === 'finish_execution');
      if (finishCall) {
        let dirty: string[] = [];
        try {
          dirty = await dirStatus(toolContext.worktreePath);
        } catch {
          // not a git worktree (test harness) — skip the gate
        }
        if (dirty.length > 0) {
          console.log(`[agent] chat=${chatId} finish_execution rejected: ${dirty.length} dirty`);
          await appendMsg({
            role: 'tool',
            results: toolCalls.map((call) => ({
              toolCallId: call.id,
              content:
                call.id === finishCall.id
                  ? JSON.stringify({
                      error:
                        `Cannot finish: the worktree has uncommitted changes:\n${dirty.join('\n')}\n` +
                        `Commit them with git_commit (or revert them) first, then call finish_execution again.`,
                    })
                  : 'Skipped: finish_execution was rejected first. Re-issue this call if still needed.',
            })),
          });
          continue;
        }
      }

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
      await setPhase('running');
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

const isCompleteJson = (s: string): boolean => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/**
 * Accumulate a tool-argument stream fragment. Normal backends send deltas
 * (concatenate); some proxies resend the FULL arguments JSON each fragment —
 * appending would corrupt it into `{...}{...}` and every call would fall back
 * to {}. When the buffer is already complete JSON and the fragment opens a
 * new object, it is such a resend: replace instead of append.
 */
export function accumulateArgs(current: string, fragment: string): string {
  if (current && fragment.trimStart().startsWith('{') && isCompleteJson(current)) {
    return fragment;
  }
  return current + fragment;
}

export function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    // Salvage concatenated full-JSON repeats (`{...}{...}`): take the last
    // balanced object rather than silently degrading to {}.
    const cut = args.lastIndexOf('}{');
    if (cut >= 0) {
      try {
        const parsed = JSON.parse(args.slice(cut + 1));
        if (typeof parsed === 'object' && parsed !== null) {
          console.warn('[agent] salvaged repeated tool-arguments stream');
          return parsed;
        }
      } catch {
        // fall through
      }
    }
    console.warn(`[agent] unparseable tool arguments (${args.length} chars) — using {}`);
    return {};
  }
}
