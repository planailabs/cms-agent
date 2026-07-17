/**
 * Tool registry — CMS tools with zod input schemas, executed via the
 * in-process MCP bridge. Client-side tools pause the turn and wait for the
 * browser (ask_question / propose_plan / finish_execution).
 */
import type { z } from 'zod';
import type { WorkflowPhase } from '../types';

/** Chat kinds: workflow chats, per-publish deployment chats, and the shared
 *  deployments system chat. */
export type ChatKind = 'workflow' | 'deployment' | 'deployments';

/** Context passed to every server-side tool execution. */
export interface ToolContext {
  chatId: string;
  branchId: string;
  branchName: string;
  userId: string;
  workflowPhase: WorkflowPhase;
  /** Chat kind — gates the tool set alongside the phase. */
  chatKind: ChatKind;
  /** Absolute path of the branch worktree (path jail root). */
  worktreePath: string;
  /** Live user context per connected editor (fed by the preview overlay). */
  userContext: Map<string, unknown>;
  /** Paths written by tools during this chat's EXECUTE phase. */
  modifiedPaths: Set<string>;
}

export interface ToolDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: Schema;
  /** Phases in which the tool is exposed AND allowed to execute. */
  phases: WorkflowPhase[];
  /** Chat kinds the tool belongs to (default: workflow chats only). */
  kinds?: ChatKind[];
  /** Client-side tools have no execute — they pause the turn for the browser. */
  execute?: (input: z.infer<Schema>, ctx: ToolContext) => Promise<string>;
}

const registry = new Map<string, ToolDef>();

export function registerTool(tool: ToolDef): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

export function toolsForPhase(phase: WorkflowPhase, kind: ChatKind = 'workflow'): ToolDef[] {
  return [...registry.values()].filter(
    (t) => t.phases.includes(phase) && (t.kinds ?? ['workflow']).includes(kind),
  );
}

export function isClientSideTool(name: string): boolean {
  const t = registry.get(name);
  return !!t && !t.execute;
}

/**
 * Execute a server-side tool with phase gating enforced here — a tool outside
 * the current phase is rejected even if the model hallucinated it.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  if (!(tool.kinds ?? ['workflow']).includes(ctx.chatKind)) {
    return JSON.stringify({ error: `Tool "${name}" is not available in this chat.` });
  }
  if (!tool.phases.includes(ctx.workflowPhase)) {
    return JSON.stringify({
      error: `Tool "${name}" is not allowed in the ${ctx.workflowPhase} phase.`,
    });
  }
  if (!tool.execute) {
    return JSON.stringify({ error: `Tool "${name}" is client-side and cannot be executed here.` });
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return JSON.stringify({ error: `Invalid input: ${parsed.error.message}` });
  }
  try {
    return await tool.execute(parsed.data, ctx);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
