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
import { ensureSandbox, runSandboxed, sandboxCommand, sandboxHasBin } from '@/lib/sandbox';
import { externalMcp, type ExternalMcp } from './external';
import type { ToolContext } from '../tools/registry';

const BIN = 'codebase-memory-mcp';
const IN_JAIL_REPO = '/work';

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

export async function attachCodebaseMemory(ctx: ToolContext): Promise<ExternalMcp | null> {
  let sb;
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

  try {
    await ensureAutoIndex(sb, ctx);
    const { command, args } = sandboxCommand(sb, [BIN], {
      cwd: ctx.worktreePath,
      sessionKey: ctx.chatId,
    });
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: 'cms-agent-codebase-memory', version: '1.0.0' });
    await client.connect(transport);
    return await externalMcp(
      client,
      (d) =>
        `${d} (Codebase graph of this chat's branch — ` +
        `the repository path inside the sandbox is ${IN_JAIL_REPO}.)`,
      'Use the codebase-memory graph tools to query the syntax tree of the branch ' +
        '(symbols, call paths, dependencies, architecture) instead of grepping for structure.',
    );
  } catch (err) {
    warnOnce(`connect failed (${err instanceof Error ? err.message : err})`);
    return null;
  }
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
      `${BIN} cli index_repository '{"repo_path":"${IN_JAIL_REPO}"}'`,
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
