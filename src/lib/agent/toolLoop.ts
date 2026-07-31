/**
 * The session loop — ported from chat/src/lib/chat/handler/toolLoop.ts.
 * Anthropic streaming → OpenAI chat.completions streaming; tools dispatched
 * through the in-process MCP bridge; same resumable turn-phase machine:
 *   idle → (rounds of tool calls) → waiting_for_answer | tool_pending → idle
 */
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { env } from '@/lib/env';
import { prisma } from '@/lib/db';
import { broadcast, isTurnStopRequested } from './bus';
import {
  compactionTranscript,
  getLastToolCalls,
  imageMimeForPath,
  sanitizeMessages,
  toOpenAiMessages,
  type FileImageResolver,
  type ImageResolver,
} from './messageUtils';
import type { PersistenceAdapter } from './persistence';
import { recordTokenUsage } from './tokenBudget';
import { reasoningEffortParam, withEffortFallback } from './reasoningEffort';
import { buildSystemPrompt, type PromptInput } from './prompt';
import { tmsg } from '@/lib/i18n';
import { createMcpBridge } from './mcp';
import { markComparePreviewsOutdated } from '@/lib/diff/screenshot';
import { routeCapabilities } from './skillRouter';
import { skillsForChat } from './plugins';
import { dirStatus } from '@/lib/git/engine';
import { isClientSideTool, type ToolContext } from './tools/registry';
import type {
  ClientToolPrompt,
  StoredMessage,
  ToolCall,
  ToolResult,
  TurnPhase,
  WorkflowPhase,
} from './types';

const MAX_TOOL_ROUNDS = 250;
/** Result for calls the stop cut short — the model reads it if the user
 *  continues the chat afterwards. */
const STOPPED_TOOL_RESULT = JSON.stringify({
  error: 'Not executed: the user stopped the turn. Ask what they want to do before retrying.',
});
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

/**
 * How a run ended. 'phase_changed' is not a finished turn: the workflow phase
 * moved under us (start_execution / return_to_plan), so this run's contract —
 * its system prompt and its tool set, both built once before the loop — no
 * longer describes what the agent may do. The handler starts a fresh run in
 * the new phase; the user sees one continuous turn.
 */
export type ToolLoopOutcome =
  | { type: 'finished' }
  /** The user pressed stop — like 'finished' for the handler: no new run. */
  | { type: 'stopped' }
  /** The contract this run was built for changed: the workflow phase moved,
   *  or the turn entered or left an automatism repair (which brings its own
   *  tools). Either way the handler starts a fresh run. */
  | { type: 'phase_changed'; phase: WorkflowPhase };

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopOutcome> {
  const e = env();
  const { chatId, messages, toolContext, setPhase, appendMsg } = input;

  const openai = new OpenAI({ baseURL: e.OPENAI_BASE_URL, apiKey: e.OPENAI_API_KEY });
  const bridge = await createMcpBridge(toolContext);

  /**
   * Compare shots are cached per (route, main sha, branch sha) — which goes
   * stale the moment the agent touches the worktree, because an EXECUTE turn
   * writes for minutes before it commits and both shas stay put. So the turn
   * itself is the signal: the shots are declared outdated when it starts, as
   * soon as a tool records a write, and when it ends. The client refetches on
   * the broadcast; a compare view nobody has open costs nothing, because the
   * recapture happens on the next request.
   */
  const invalidateCompare = (): void => {
    if (toolContext.chatKind === 'deployments') return; // no worktree of its own
    const generation = markComparePreviewsOutdated(toolContext.branchName);
    broadcast(chatId, 'compare_stale', { type: 'compare_stale', generation });
  };
  invalidateCompare();

  /** Ends the turn for the client: the shots are stale before 'done', because
   *  'done' is the event everything else treats as the end of the turn. */
  const finishTurn = (): void => {
    invalidateCompare();
    broadcast(chatId, 'done', { type: 'done' });
  };

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
    // toOpenAiMessages runs every round — memoize so each image is read and
    // base64-encoded once per turn, not once per round.
    const encoded = new Map<string, { mime: string; dataUrl: string } | null>();
    resolveImage = (uploadId) => {
      if (encoded.has(uploadId)) return encoded.get(uploadId)!;
      const u = byId.get(uploadId);
      let result: { mime: string; dataUrl: string } | null = null;
      if (u) {
        try {
          const b = fs.readFileSync(u.storedPath);
          result = { mime: u.mime, dataUrl: `data:${u.mime};base64,${b.toString('base64')}` };
        } catch {
          result = null;
        }
      }
      encoded.set(uploadId, result);
      return result;
    };
  }

  // read_file on a repo image inlines the pixels the same way (the tool
  // result itself is only a text marker — bytes never enter chat history).
  const fileImages = new Map<string, { mime: string; dataUrl: string } | null>();
  const worktreeRoot = path.resolve(toolContext.worktreePath);
  const resolveFileImage: FileImageResolver = (rel) => {
    if (fileImages.has(rel)) return fileImages.get(rel)!;
    let result: { mime: string; dataUrl: string } | null = null;
    const mime = imageMimeForPath(rel);
    const abs = path.resolve(worktreeRoot, rel);
    if (mime && (abs === worktreeRoot || abs.startsWith(worktreeRoot + path.sep))) {
      try {
        const b = fs.readFileSync(abs);
        // Chat Completions data-URL practical limit — skip absurd files
        if (b.length > 0 && b.length <= 8 * 1024 * 1024) {
          result = { mime, dataUrl: `data:${mime};base64,${b.toString('base64')}` };
        }
      } catch {
        result = null;
      }
    }
    fileImages.set(rel, result);
    return result;
  };

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
    // What this turn is hinted with. The router decides; a failure here fails
    // the turn, because the alternative is an unrouted prompt carrying every
    // skill in the install — silently, forever (see skillRouter.ts).
    const groupViews = bridge.control.index();
    const routed = await routeCapabilities({
      chatId,
      messages,
      skills: skillsForChat(toolContext.worktreePath),
      groups: groupViews,
      phase: toolContext.workflowPhase,
      kind: toolContext.chatKind,
    });
    totalInputTokens += routed.inputTokens;
    totalOutputTokens += routed.outputTokens;

    const systemPrompt = buildSystemPrompt({
      ...input.promptInput,
      mcpHints: bridge.promptHints(),
      mcpGroups: groupViews,
      routedSkills: routed.skills,
      routedGroups: routed.groups,
      ...(toolContext.repair
        ? {
            repair: {
              type: toolContext.repair.type,
              stepName: toolContext.repair.stepName,
              tools: [...toolContext.repair.tools].sort(),
            },
          }
        : {}),
    });
    const detectLoop = createLoopDetector();
    let compactedForRequest = false;

    const compactContext = async (): Promise<void> => {
      broadcast(chatId, 'compaction_start', { type: 'compaction_start' });
      let maxChars = 120_000;
      let compacted: OpenAI.Chat.Completions.ChatCompletion;
      for (;;) {
        try {
          compacted = await withEffortFallback(() => openai.chat.completions.create({
            model: e.OPENAI_MODEL,
            ...reasoningEffortParam(),
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
          }));
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

    /**
     * End the turn where the user asked it to. Whatever the model already said
     * is kept — it is what happened — and the transcript gets a note of its
     * own, carried as a TranslatedMessage so every viewer reads it in their
     * language. The 'stopped' event is what tells the browser its Stop landed;
     * 'done' then closes the turn exactly like any other ending.
     */
    const endStopped = async (partialText = ''): Promise<ToolLoopOutcome> => {
      console.log(`[agent] chat=${chatId} stopped by the user`);
      if (partialText) {
        await appendMsg({ role: 'assistant', content: partialText });
        broadcast(chatId, 'text_done', { type: 'text_done', content: partialText });
      }
      await appendMsg({ role: 'cancel', content: tmsg('chat.stopped').fallback, tm: tmsg('chat.stopped') });
      await setPhase('idle');
      broadcast(chatId, 'stopped', { type: 'stopped' });
      finishTurn();
      await flushTokens();
      return { type: 'stopped' };
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
    // The phase this run was built for: `systemPrompt` above is a snapshot of
    // it, and so is the tool set the registry hands out per round. A tool that moves the workflow (start_execution,
    // return_to_plan) invalidates both, so the run ends at the next loop head
    // instead of continuing to plan with EXECUTE tools — or worse, promising
    // an implementation it has no write tools to carry out.
    const runPhase = toolContext.workflowPhase;
    // A repair's tool set and prompt are as much this run's contract as the
    // phase is; starting or ending one invalidates the snapshot the same way.
    const runRepair = toolContext.repair?.automatismId ?? null;
    let modifiedBefore = toolContext.modifiedPaths.size;
    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      if (isTurnStopRequested(chatId)) return await endStopped();
      if (toolContext.workflowPhase !== runPhase) {
        console.log(
          `[agent] chat=${chatId} phase ${runPhase} → ${toolContext.workflowPhase}, restarting the run`,
        );
        return { type: 'phase_changed', phase: toolContext.workflowPhase };
      }
      if ((toolContext.repair?.automatismId ?? null) !== runRepair) {
        console.log(
          `[agent] chat=${chatId} repair ${runRepair ?? '-'} → ${toolContext.repair?.automatismId ?? '-'}, restarting the run`,
        );
        return { type: 'phase_changed', phase: toolContext.workflowPhase };
      }
      rounds++;

      // Rebuilt every round: load_mcp adds an MCP group's tools mid-run, and
      // this is where they enter the request (in-memory listing, no I/O).
      const tools = await bridge.asOpenAiTools();

      const chatMessages = sanitizeMessages(
        toOpenAiMessages(messages.filter((m) => m.role !== 'cancel'), resolveImage, resolveFileImage),
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
        const stream = await withEffortFallback(() => openai.chat.completions.create({
          model,
          ...reasoningEffortParam(),
          max_tokens: e.OPENAI_MAX_TOKENS,
          messages: [{ role: 'system', content: systemPrompt }, ...chatMessages],
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true },
        }));

        for await (const chunk of stream) {
          if (isTurnStopRequested(chatId)) {
            // Close the HTTP stream too — nobody is going to read the rest.
            stream.controller.abort();
            break;
          }
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
        // Our own abort surfaces here — the stop is handled right below.
        if (isTurnStopRequested(chatId)) return await endStopped(text);
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

      if (isTurnStopRequested(chatId)) return await endStopped(text);
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
        finishTurn();
        await flushTokens();
        return { type: 'finished' };
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
        return { type: 'finished' };
      }

      // ── Server-side tools ──────────────────────────────────────────────────
      await setPhase('tool_pending');
      const results: ToolResult[] = [];
      for (const call of toolCalls) {
        // Every call still needs a result row — an assistant tool_call without
        // one is a malformed conversation the next turn would send to the model.
        if (isTurnStopRequested(chatId)) {
          results.push({ toolCallId: call.id, content: STOPPED_TOOL_RESULT });
          continue;
        }
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
      // A write mid-turn: whoever has the compare view open should see the
      // page as it is now, not as it was when the turn started. (run_command
      // and skill scripts write without recording a path — the turn's own
      // end-of-run invalidation is what covers those.)
      if (toolContext.modifiedPaths.size !== modifiedBefore) {
        modifiedBefore = toolContext.modifiedPaths.size;
        invalidateCompare();
      }
      if (isTurnStopRequested(chatId)) return await endStopped();
      await setPhase('running');
    }

    // ── Max rounds reached ─────────────────────────────────────────────────
    const msg =
      "I've been working on your request but it required too many steps. Could you try a more specific request?";
    await appendMsg({ role: 'assistant', content: msg });
    await setPhase('idle');
    broadcast(chatId, 'text_done', { type: 'text_done', content: msg });
    finishTurn();
    await flushTokens();
    return { type: 'finished' };
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
