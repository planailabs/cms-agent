/**
 * Chat handler — ported from chat/src/lib/chat/handler/index.ts.
 * Loads chat state from Prisma, applies the incoming message/answer to the
 * turn state machine, then runs the tool loop. Server is the source of truth.
 */
import { prisma } from '@/lib/db';
import { broadcast } from './bus';
import { getLastToolCalls } from './messageUtils';
import {
  createDbAdapter,
  createMemoryAdapter,
  loadChatRecord,
  memoryRecords,
} from './persistence';
import { checkTokenBudget } from './tokenBudget';
import { buildQuestionToolResults, runToolLoop } from './toolLoop';
import { isClientSideTool, type ChatKind, type ToolContext } from './tools/registry';
import { registerClientTools } from './tools/clientTools';
import { registerFsTools } from './tools/fsTools';
import { registerUploadTools } from './tools/uploadTools';
import { registerMemoryTools } from './tools/memoryTools';
import { registerContentTools } from '@/lib/content/tools';
import { registerLintTools } from './tools/lintTools';
import { registerStructureTools } from './tools/structureTools';
import { registerDeployTools } from './tools/deployTools';
import { registerChatTools } from './tools/chatTools';
import { registerScratchTools } from './tools/scratchTools';
import { getApprovedMemories } from '@/lib/memory';
import { getUserContextStore } from './userContext';
import { ensureWorktree } from '@/lib/git/engine';
import type {
  ClientToolPrompt,
  IncomingChatMessage,
  StoredMessage,
  TurnPhase,
  WorkflowPhase,
} from './types';

registerClientTools();
registerFsTools();
registerUploadTools();
registerMemoryTools();
registerContentTools();
registerLintTools();
registerStructureTools();
registerDeployTools();
registerChatTools();
registerScratchTools();

export interface HandleOptions {
  /** In-memory persistence for integration tests (no DB writes). */
  skipPersistence?: boolean;
  /** Test mode: worktree the tools operate on (defaults to none). */
  worktreePath?: string;
  /** Test mode: workflow phase (defaults to plan). */
  workflowPhase?: WorkflowPhase;
}

export async function handleChatMessage(
  userId: string,
  locale: string,
  body: IncomingChatMessage,
  opts: HandleOptions = {},
): Promise<void> {
  const { chatId } = body;

  // ── Budget ────────────────────────────────────────────────────────────────
  if (!opts.skipPersistence) {
    const { allowed, inputUsed, outputUsed } = await checkTokenBudget(userId);
    if (!allowed) {
      broadcast(chatId, 'error', {
        type: 'error',
        message: `Token rate limit exceeded (input ${inputUsed}, output ${outputUsed} in the last hour). Try again later.`,
      });
      return;
    }
  }

  // ── Load state ────────────────────────────────────────────────────────────
  let phase: TurnPhase = 'idle';
  let pendingQuestion: ClientToolPrompt | null = null;
  let messages: StoredMessage[] = [];
  let branchId = '';
  let branchName = '';
  let targetBranchName = 'main';
  let chatKind: ChatKind = 'workflow';
  let needsTitle = false;
  let workflowPhase: WorkflowPhase = 'plan';
  let planJson: unknown;
  let nextOrdinal = 0;

  if (opts.skipPersistence) {
    const rec = memoryRecords.get(chatId);
    if (rec) {
      phase = rec.phase;
      pendingQuestion = rec.pendingQuestion;
      messages = rec.messages;
    }
    branchName = 'test';
    if (opts.workflowPhase) workflowPhase = opts.workflowPhase;
  } else {
    const record = await loadChatRecord(chatId);
    if (!record) {
      broadcast(chatId, 'error', { type: 'error', message: 'Chat not found' });
      return;
    }
    phase = record.phase;
    pendingQuestion = record.pendingQuestion;
    messages = record.messages;
    branchId = record.branchId;
    workflowPhase = record.workflowPhase as WorkflowPhase;
    nextOrdinal = record.nextOrdinal;

    const [branch, chat] = await Promise.all([
      prisma.branch.findUniqueOrThrow({ where: { id: record.branchId } }),
      prisma.chat.findUniqueOrThrow({
        where: { id: chatId },
        select: { planJson: true, workBranch: true, kind: true, title: true },
      }),
    ]);
    targetBranchName = branch.name;
    branchName = chat.workBranch; // the chat's own work branch
    chatKind = chat.kind as ChatKind;
    planJson = chat.planJson ?? undefined;
    needsTitle = chat.title === 'New chat';
  }

  const ordinalRef = { value: nextOrdinal };
  const adapter = opts.skipPersistence
    ? createMemoryAdapter(chatId, messages)
    : createDbAdapter(chatId, userId, messages, ordinalRef);

  const setPhase = async (p: TurnPhase, q?: ClientToolPrompt | null) => {
    phase = p;
    pendingQuestion = q ?? null;
    await adapter.setPhase(p, q);
  };
  const appendMsg = (msg: StoredMessage) => adapter.appendMsg(msg);

  // ── Apply incoming message to the state machine ───────────────────────────
  if (body.type === 'answer') {
    if (phase !== 'waiting_for_answer') {
      broadcast(chatId, 'error', { type: 'error', message: 'No pending question to answer' });
      return;
    }
    const answer = body.text;
    const cancelled = answer === '__cancel__';

    const toolCalls = getLastToolCalls(messages);
    if (!toolCalls) {
      broadcast(chatId, 'error', { type: 'error', message: 'Resume error: no tool calls found' });
      return;
    }
    const clientCall = toolCalls.find((c) => isClientSideTool(c.function.name));

    if (cancelled) {
      await appendMsg({ role: 'cancel', content: '' });
    } else {
      await appendMsg({ role: 'user', content: answer, pageContext: body.pageContext });
    }
    await appendMsg({
      role: 'tool',
      results: buildQuestionToolResults(toolCalls, clientCall?.id ?? '', answer, cancelled),
    });
    await setPhase('idle');
  } else if (body.type === 'message') {
    if (phase === 'waiting_for_answer' || phase === 'tool_pending') {
      broadcast(chatId, 'error', {
        type: 'error',
        message: 'A conversation turn is already in progress',
      });
      return;
    }
    await appendMsg({ role: 'user', content: body.text, pageContext: body.pageContext });
    await setPhase('idle');
  } else {
    broadcast(chatId, 'error', { type: 'error', message: `Unknown message type: ${body.type}` });
    return;
  }

  // ── Tool context: the chat's own worktree, based on its target branch.
  // System chats (deployments) have no repo tools and need no worktree. ─────
  const worktreePath = opts.skipPersistence
    ? (opts.worktreePath ?? '')
    : chatKind === 'deployments'
      ? ''
      : await ensureWorktree(branchName, targetBranchName);

  const toolContext: ToolContext = {
    chatId,
    branchId,
    branchName,
    userId,
    workflowPhase,
    chatKind,
    worktreePath,
    userContext: getUserContextStore(chatId),
    modifiedPaths: new Set(),
  };

  const [extension, approvedMemories] = opts.skipPersistence
    ? [undefined, undefined]
    : await Promise.all([
        prisma.systemPromptExtension.findUnique({ where: { userId } }).then((r) => r?.content),
        getApprovedMemories(),
      ]);

  await runToolLoop({
    chatId,
    userId,
    messages,
    phase,
    toolContext,
    promptInput: {
      kind: chatKind,
      phase: workflowPhase,
      branchName: opts.skipPersistence ? branchName : `${branchName} (merges into ${targetBranchName})`,
      locale,
      planJson,
      extension,
      approvedMemories,
      needsTitle,
    },
    setPhase,
    appendMsg,
    skipTokenAccounting: opts.skipPersistence,
  });
}
