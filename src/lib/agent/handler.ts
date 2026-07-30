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
import { registerTaskTools, taskListForPrompt } from './tools/taskTools';
import { registerJsonTools } from './tools/jsonTools';
import { registerScreenshotTools } from './tools/screenshotTools';
import { registerCommitTools } from './tools/commitTools';
import { registerCommandTools } from './tools/commandTools';
import { registerAutomatismTools } from './tools/automatismTools';
import { registerConflictTools } from './tools/conflictTools';
import { registerSkillTools } from './tools/skillTools';
import { registerImageTools } from './tools/imageTools';
import { registerFirecrawlTools } from './tools/firecrawlTools';
import { getApprovedMemories } from '@/lib/memory';
import { getUserContextStore } from './userContext';
import { ensureWorktree } from '@/lib/git/engine';
import { communicationModeForUser } from '@/lib/communicationMode';
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
registerTaskTools();
registerJsonTools();
registerScreenshotTools();
registerCommitTools();
registerCommandTools();
registerAutomatismTools();
registerConflictTools();
registerSkillTools();
registerImageTools();
registerFirecrawlTools();

/** Phase flips per turn before we stop granting fresh runs. */
const MAX_PHASE_RUNS = 4;

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

  // Chat-scoped attachment metadata for the incoming message (validated in the
  // endpoint). Client-safe fields only — storedPath is resolved later, server-side.
  const attachments =
    !opts.skipPersistence && body.attachmentIds?.length
      ? await prisma.upload.findMany({
          where: { id: { in: body.attachmentIds }, chatId },
          select: { id: true, mime: true, filename: true },
        })
      : undefined;

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
      await appendMsg({ role: 'user', content: answer, pageContext: body.pageContext, attachments });
    }
    await appendMsg({
      role: 'tool',
      results: buildQuestionToolResults(toolCalls, clientCall?.id ?? '', answer, cancelled),
    });
    await setPhase('idle');
  } else if (body.type === 'message') {
    if (phase === 'running' || phase === 'waiting_for_answer' || phase === 'tool_pending') {
      broadcast(chatId, 'error', {
        type: 'error',
        message: 'A conversation turn is already in progress',
      });
      return;
    }
    await appendMsg({ role: 'user', content: body.text, pageContext: body.pageContext, attachments });
    await setPhase('idle');
  } else if (body.type === 'continue') {
    // Resume after a failed turn or a server restart: nothing is appended —
    // the loop re-runs from stored state ('tool_pending' re-executes the
    // pending tool calls first via the resume pre-step).
    if (phase === 'waiting_for_answer') {
      broadcast(chatId, 'error', { type: 'error', message: 'Answer the pending question instead' });
      return;
    }
    if (messages.length === 0) {
      broadcast(chatId, 'error', { type: 'error', message: 'Nothing to continue' });
      return;
    }
  } else {
    broadcast(chatId, 'error', { type: 'error', message: `Unknown message type: ${body.type}` });
    return;
  }

  // ── Tool context: the chat's own worktree, based on its target branch.
  // Deployment chats operate on the SOURCE chat's work worktree (conflict
  // resolution); the shared deployments system chat has no worktree. ────────
  let worktreePath = '';
  let deployFlowId: string | undefined;
  if (opts.skipPersistence) {
    worktreePath = opts.worktreePath ?? '';
  } else if (chatKind === 'workflow') {
    worktreePath = await ensureWorktree(branchName, targetBranchName);
  } else if (chatKind === 'deployment') {
    const automatism = await prisma.automatism.findFirst({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
    });
    const data = automatism?.data as { workBranch?: string; flowId?: string | null } | null;
    if (data?.workBranch) {
      branchName = data.workBranch; // repo/git tools act on the source work branch
      worktreePath = await ensureWorktree(data.workBranch, targetBranchName);
    }
    deployFlowId = data?.flowId ?? undefined;
  }

  const toolContext: ToolContext = {
    chatId,
    branchId,
    branchName,
    userId,
    // Deployment chats gate tools like EXECUTE (edits, git_commit, conflict
    // helpers) — their persisted phase is a static 'published'.
    workflowPhase: chatKind === 'deployment' ? 'execute' : workflowPhase,
    chatKind,
    targetBranchName,
    deployFlowId,
    worktreePath,
    userContext: getUserContextStore(chatId),
    modifiedPaths: new Set(),
  };

  const [extension, approvedMemories, communicationMode, taskList] = opts.skipPersistence
    ? [undefined, undefined, 'non-technical' as const, null]
    : await Promise.all([
        prisma.systemPromptExtension.findUnique({ where: { userId } }).then((r) => r?.content),
        getApprovedMemories(),
        communicationModeForUser(userId),
        taskListForPrompt(chatId),
      ]);

  // ── Run the turn ──────────────────────────────────────────────────────────
  // A workflow-phase change ends the run and starts a new one. The system
  // prompt and the tool set are built once per run, so a phase flip mid-run
  // (start_execution, return_to_plan) would leave the agent planning with
  // EXECUTE tools, or promising an implementation with none. Each run gets a
  // contract for exactly one phase; the user sees one uninterrupted turn,
  // because nothing here broadcasts 'done' between runs.
  let taskListForRun = taskList;
  for (let run = 1; ; run++) {
    const outcome = await runToolLoop({
      chatId,
      userId,
      messages,
      phase,
      toolContext,
      promptInput: {
        kind: chatKind,
        phase: workflowPhase,
        branchName: opts.skipPersistence
          ? branchName
          : `${branchName} (merges into ${targetBranchName})`,
        locale,
        planJson,
        extension,
        approvedMemories,
        needsTitle,
        taskList: taskListForRun,
        worktreePath,
        hasAttachments: messages.some((m) => m.role === 'user' && !!m.attachments?.length),
        communicationMode,
      },
      setPhase,
      appendMsg,
      skipTokenAccounting: opts.skipPersistence,
    });
    if (outcome.type !== 'phase_changed') return;

    if (run >= MAX_PHASE_RUNS) {
      // Guard against a plan↔execute ping-pong: end the turn instead of
      // handing out another run.
      const msg =
        'I kept switching between planning and implementing without settling. ' +
        'Could you tell me which part to do first?';
      await appendMsg({ role: 'assistant', content: msg });
      await setPhase('idle');
      broadcast(chatId, 'text_done', { type: 'text_done', content: msg });
      broadcast(chatId, 'done', { type: 'done' });
      return;
    }

    // Re-read what the transition wrote: the new phase's prompt needs the
    // recorded plan, and the agent may have added tasks on the way here.
    workflowPhase = outcome.phase;
    toolContext.workflowPhase = workflowPhase;
    if (!opts.skipPersistence) {
      const [chat, tasks] = await Promise.all([
        prisma.chat.findUnique({ where: { id: chatId }, select: { planJson: true } }),
        taskListForPrompt(chatId),
      ]);
      planJson = chat?.planJson ?? undefined;
      taskListForRun = tasks;
    }
  }
}
