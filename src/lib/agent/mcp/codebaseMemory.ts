/**
 * codebase-memory-mcp attachment — a stdio MCP server (static C binary in the
 * SANDBOX env) connected per turn and merged into the agent's tool set. It
 * runs inside the bwrap jail with the chat's worktree at /work and a per-chat
 * HOME, so it can only ever see (and index) the branch; the graph index
 * persists in the jail HOME across turns.
 *
 * Fails soft: no sandbox / no binary / connect error → the agent simply works
 * without graph tools (warned once).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { simpleGit } from 'simple-git';
import { ensureSandbox, runSandboxed, sandboxCommand, sandboxHasBin } from '@/lib/sandbox';
import { externalMcp, type ExternalMcp } from './external';
import type { ToolContext } from '../tools/registry';

const BIN = 'codebase-memory-mcp';
/** Repo path as the sandboxed MCP server sees it: /work in the jail, the
 *  real worktree path in the SANDBOX_MODE=none dev fallback. */
const repoPathFor = (sb: { mode: 'bwrap' | 'none' }, worktreePath: string): string =>
  sb.mode === 'none' ? worktreePath : '/work';

let warned = false;
const warnOnce = (msg: string): void => {
  if (!warned) console.warn(`[codebase-memory] ${msg} — graph tools disabled`);
  warned = true;
};

/**
 * Auto-index is off upstream by default; with it on, the MCP server refreshes
 * the graph on start when the branch changed (the agent commits between
 * turns). The flag persists in the per-chat jail HOME (sqlite config), so
 * setting it once per chat is enough — the memo just skips repeat spawns.
 */
const autoIndexEnabled = new Set<string>();
async function ensureAutoIndex(sb: Awaited<ReturnType<typeof ensureSandbox>>, ctx: ToolContext) {
  if (autoIndexEnabled.has(ctx.chatId)) return;
  const res = await runSandboxed(sb, `${BIN} config set auto_index true`, {
    cwd: ctx.worktreePath,
    sessionKey: ctx.chatId,
    timeoutMs: 30_000,
  });
  if (res.code === 0) autoIndexEnabled.add(ctx.chatId);
  else console.warn(`[codebase-memory] enabling auto_index failed: ${res.stderr || res.stdout}`);
}

interface CachedAttachment {
  headSha: string;
  attachment: Promise<ExternalMcp | null>;
  client: Client | null;
}

// Cached per chat across turns (globalThis: survive Vite HMR reloads in dev,
// same pattern as custom.ts). The server auto-refreshes its graph only on
// START, so the cache key includes the worktree HEAD: a commit between turns
// respawns (and thus reindexes); everything else reuses the live process.
const g = globalThis as unknown as { __cbmCache?: Map<string, CachedAttachment> };
const cache = (): Map<string, CachedAttachment> => (g.__cbmCache ??= new Map());
const MAX_CACHED = 8;

async function closeCached(state: CachedAttachment): Promise<void> {
  try {
    await state.attachment;
    await state.client?.close();
  } catch {
    /* old server teardown must not affect the new one */
  }
}

export async function attachCodebaseMemory(ctx: ToolContext): Promise<ExternalMcp | null> {
  let sb: Awaited<ReturnType<typeof ensureSandbox>>;
  try {
    sb = await ensureSandbox();
  } catch (err) {
    warnOnce(`sandbox unavailable (${err instanceof Error ? err.message : err})`);
    return null;
  }
  if (!sandboxHasBin(sb, BIN)) {
    warnOnce('binary not in the sandbox env (rebuild .#sandbox)');
    return null;
  }

  let headSha = '';
  try {
    headSha = (await simpleGit(ctx.worktreePath).revparse(['HEAD'])).trim();
  } catch {
    // worktree gone/uninitialized — drop any cached server for this chat
    const old = cache().get(ctx.chatId);
    if (old) {
      void closeCached(old);
      cache().delete(ctx.chatId);
    }
    return null;
  }

  const cur = cache().get(ctx.chatId);
  if (cur && cur.headSha === headSha) {
    // Re-insert: Map order is the LRU order the eviction below relies on.
    cache().delete(ctx.chatId);
    cache().set(ctx.chatId, cur);
    return cur.attachment;
  }
  if (cur) void closeCached(cur);

  const state: CachedAttachment = { headSha, client: null, attachment: Promise.resolve(null) };
  state.attachment = (async (): Promise<ExternalMcp | null> => {
    await ensureAutoIndex(sb, ctx);
    const { command, args } = sandboxCommand(sb, [BIN], {
      cwd: ctx.worktreePath,
      sessionKey: ctx.chatId,
    });
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: 'cms-agent-codebase-memory', version: '1.0.0' });
    await client.connect(transport);
    state.client = client;
    const ext = await externalMcp(
      client,
      (d) =>
        `${d} (Codebase graph of this chat's branch — ` +
        `the repository path inside the sandbox is ${repoPathFor(sb, ctx.worktreePath)}.)`,
      'Use the codebase-memory graph tools to query the syntax tree of the branch ' +
        '(symbols, call paths, dependencies, architecture) instead of grepping for structure.',
    );
    // The server outlives the turn; the cache owns the real teardown.
    return { ...ext, close: async () => {} };
  })().catch((err: unknown) => {
    warnOnce(`connect failed (${err instanceof Error ? err.message : err})`);
    cache().delete(ctx.chatId);
    return null;
  });

  cache().delete(ctx.chatId);
  cache().set(ctx.chatId, state);
  // Bounded: evict the least-recently attached chat's server.
  while (cache().size > MAX_CACHED) {
    const [oldestKey, oldest] = cache().entries().next().value as [string, CachedAttachment];
    void closeCached(oldest);
    cache().delete(oldestKey);
  }
  return state.attachment;
}

/**
 * Index a chat's work branch (fire-and-forget on chat creation). Runs the
 * CLI in the same jail/HOME the per-turn MCP server uses, so the index it
 * builds is the one the agent queries.
 */
export async function indexChatWorktree(chatId: string, worktreePath: string): Promise<void> {
  try {
    const sb = await ensureSandbox();
    if (!sandboxHasBin(sb, BIN)) return;
    const res = await runSandboxed(
      sb,
      `${BIN} cli index_repository '{"repo_path":"${repoPathFor(sb, worktreePath)}"}'`,
      { cwd: worktreePath, sessionKey: chatId, timeoutMs: 10 * 60_000 },
    );
    if (res.code === 0) {
      console.log(`[codebase-memory] indexed ${worktreePath} for chat ${chatId}`);
    } else {
      console.warn(`[codebase-memory] index failed (${res.code}): ${res.stderr || res.stdout}`);
    }
  } catch (err) {
    console.warn(`[codebase-memory] index skipped: ${err instanceof Error ? err.message : err}`);
  }
}
