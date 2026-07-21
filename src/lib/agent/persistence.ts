/**
 * Persistence — Prisma-backed chat state/messages plus the in-memory adapter
 * for skipPersistence test mode. Ported from chat/'s persistence.ts.
 */
import { dbNull, prisma } from '@/lib/db';
import type {
  ClientToolPrompt,
  PageContext,
  StoredMessage,
  ToolCall,
  ToolResult,
  TurnPhase,
} from './types';

export interface MemoryState {
  phase: TurnPhase;
  pendingQuestion: ClientToolPrompt | null;
  messages: StoredMessage[];
}

export const memoryRecords = new Map<string, MemoryState>();

export interface PersistenceAdapter {
  setPhase(phase: TurnPhase, pendingQuestion?: ClientToolPrompt | null): Promise<void>;
  appendMsg(msg: StoredMessage): Promise<void>;
}

// ─── Display text ────────────────────────────────────────────────────────────

export const extractDisplayText = (msg: StoredMessage): string => {
  if (msg.role === 'tool') return '';
  return msg.content;
};

// ─── DB operations ───────────────────────────────────────────────────────────

export async function loadChatRecord(chatId: string): Promise<{
  phase: TurnPhase;
  pendingQuestion: ClientToolPrompt | null;
  messages: StoredMessage[];
  branchId: string;
  workflowPhase: string;
  nextOrdinal: number;
} | null> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) return null;
  const checkpoint = await prisma.message.findFirst({
    where: { chatId, role: 'compaction' },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  const rows = await prisma.message.findMany({
    where: { chatId, ...(checkpoint ? { ordinal: { gte: checkpoint.ordinal } } : {}) },
    orderBy: { ordinal: 'asc' },
  });

  const messages: StoredMessage[] = rows.map((row) => {
    if (row.role === 'cancel') return { id: row.id, role: 'cancel', content: row.content };
    if (row.role === 'assistant') {
      return {
        id: row.id,
        role: 'assistant',
        content: row.content,
        toolCalls: (row.contentBlocks as ToolCall[] | null) ?? undefined,
      };
    }
    if (row.role === 'tool') {
      return { id: row.id, role: 'tool', results: (row.contentBlocks as ToolResult[] | null) ?? [] };
    }
    if (row.role === 'automatism') {
      return { id: row.id, role: 'automatism', content: row.content };
    }
    if (row.role === 'compaction') {
      return { id: row.id, role: 'compaction', content: row.content };
    }
    return {
      id: row.id,
      role: 'user',
      content: row.content,
      pageContext: (row.pageContext as PageContext | null) ?? undefined,
    };
  });

  const last = rows[rows.length - 1];
  return {
    phase: chat.turnPhase as TurnPhase,
    pendingQuestion: (chat.pendingQuestion as ClientToolPrompt | null) ?? null,
    messages,
    branchId: chat.branchId,
    workflowPhase: chat.workflowPhase,
    nextOrdinal: last ? last.ordinal + 1 : 0,
  };
}

export function createDbAdapter(
  chatId: string,
  authorId: string | null,
  messages: StoredMessage[],
  ordinalRef: { value: number },
): PersistenceAdapter {
  return {
    async setPhase(phase, pendingQuestion) {
      await prisma.chat.update({
        where: { id: chatId },
        data: {
          turnPhase: phase,
          pendingQuestion:
            pendingQuestion === undefined
              ? undefined
              : pendingQuestion === null
                ? dbNull
                : (pendingQuestion as object),
        },
      });
      // Remote turn state: every phase persist streams a fresh snapshot
      const { emitChatState } = await import('./chatState');
      emitChatState(chatId);
    },
    async appendMsg(msg) {
      messages.push(msg);
      const contentBlocks =
        msg.role === 'assistant' ? (msg.toolCalls as object[] | undefined) ?? null
        : msg.role === 'tool' ? (msg.results as object[])
        : null;
      // Ordinals come from an in-memory counter; an automatism message can
      // land mid-turn and take the next ordinal — on collision resync the
      // counter to the DB and retry.
      for (let attempt = 0; ; attempt++) {
        const ordinal = ordinalRef.value++;
        try {
          const row = await prisma.message.create({
            data: {
              chatId,
              authorId: msg.role === 'user' || msg.role === 'cancel' ? authorId : null,
              role: msg.role,
              content: extractDisplayText(msg),
              contentBlocks: contentBlocks ?? undefined,
              pageContext: msg.role === 'user' ? ((msg.pageContext as object | undefined) ?? undefined) : undefined,
              ordinal,
            },
          });
          msg.id = row.id;
          return;
        } catch (err) {
          if ((err as { code?: string })?.code !== 'P2002' || attempt >= 4) throw err;
          const last = await prisma.message.findFirst({
            where: { chatId },
            orderBy: { ordinal: 'desc' },
            select: { ordinal: true },
          });
          ordinalRef.value = (last?.ordinal ?? -1) + 1;
        }
      }
    },
  };
}

export function createMemoryAdapter(key: string, messages: StoredMessage[]): PersistenceAdapter {
  return {
    async setPhase(phase, pendingQuestion) {
      let rec = memoryRecords.get(key);
      if (!rec) {
        rec = { phase: 'idle', pendingQuestion: null, messages };
        memoryRecords.set(key, rec);
      }
      rec.phase = phase;
      rec.pendingQuestion = pendingQuestion ?? null;
      rec.messages = messages;
    },
    async appendMsg(msg) {
      messages.push(msg);
      const rec = memoryRecords.get(key);
      if (rec) rec.messages = messages;
    },
  };
}
