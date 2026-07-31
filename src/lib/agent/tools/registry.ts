/**
 * Tool registry — CMS tools with zod input schemas, executed via the
 * in-process MCP bridge. Client-side tools pause the turn and wait for the
 * browser (ask_question / pick_color / finish_execution).
 */
import type { z } from 'zod';
import type { WorkflowPhase } from '../types';
import type { McpControl } from '../mcp';
import type { RepairContext } from '../../automatism';

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
  /** Target branch the work branch merges into (deployment-chat tools). */
  targetBranchName?: string;
  /** Deploy flow of the chat's automatism (deployment chats). */
  deployFlowId?: string;
  /** The chat is in explicit plan mode (see lib/commands). */
  planMode?: boolean;
  /** Live user context per connected editor (fed by the preview overlay). */
  userContext: Map<string, unknown>;
  /** MCP groups whose tools this chat has loaded (phase defaults + load_mcp).
   *  Seeded by the handler from the chat row, mutated by the bridge. */
  loadedMcpGroups?: Set<string>;
  /**
   * Set while this turn is repairing a paused automatism: the failed step
   * brings its own tools, and they REPLACE the phase's (see lib/automatism).
   * Cleared by resume_automatism — leaving the repair is a contract change,
   * so the run ends and a fresh one starts, exactly like a phase flip.
   */
  repair?: RepairContext;
  /** Load/unload handle, published by createMcpBridge for the capability tools. */
  mcp?: McpControl;
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
  /** Deploy-flow scoping: only exposed when the chat's automatism runs one
   *  of these flows (set by registerDeployFlow for flow tools). */
  flows?: string[];
  /** Explicit plan mode (the /plan command) — 'only' exposes the tool just
   *  in that mode, 'never' hides it there. Unset: exposed either way. */
  planMode?: 'only' | 'never';
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

export function toolsForPhase(
  phase: WorkflowPhase,
  kind: ChatKind = 'workflow',
  deployFlowId?: string,
  planMode = false,
): ToolDef[] {
  return [...registry.values()].filter(
    (t) =>
      t.phases.includes(phase) &&
      (t.kinds ?? ['workflow']).includes(kind) &&
      (!t.flows || (deployFlowId != null && t.flows.includes(deployFlowId))) &&
      allowedInMode(t, planMode),
  );
}

/**
 * The tool set for one turn.
 *
 * A repair turn gets the failed step's own set instead of the chat's phase
 * tools. The phase describes what the USER's work is up to; a paused step is
 * a different job with different needs, and inheriting the phase meant either
 * moving the chat into EXECUTE by force to unlock writes or leaving the agent
 * without the tools it was invoked to use. Chat-kind scoping still applies —
 * a repair cannot reach tools that chat kind never has.
 */
export function toolsForTurn(ctx: ToolContext): ToolDef[] {
  if (!ctx.repair) {
    return toolsForPhase(ctx.workflowPhase, ctx.chatKind, ctx.deployFlowId, ctx.planMode);
  }
  const wanted = ctx.repair.tools;
  return [...registry.values()].filter(
    (t) =>
      wanted.has(t.name) &&
      (t.kinds ?? ['workflow']).includes(ctx.chatKind) &&
      (!t.flows || (ctx.deployFlowId != null && t.flows.includes(ctx.deployFlowId))),
  );
}

const allowedInMode = (tool: ToolDef, planMode: boolean): boolean =>
  tool.planMode === 'only' ? planMode : tool.planMode === 'never' ? !planMode : true;

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
  if (tool.flows && (!ctx.deployFlowId || !tool.flows.includes(ctx.deployFlowId))) {
    return JSON.stringify({ error: `Tool "${name}" belongs to another deploy flow.` });
  }
  // A repair turn is authorized by its step, not by the phase: the same list
  // that produced the tool set is re-checked here, so a hallucinated call to
  // something the step did not ask for is refused like any other.
  if (ctx.repair) {
    if (!ctx.repair.tools.has(name)) {
      return JSON.stringify({
        error:
          `Tool "${name}" is not part of repairing step "${ctx.repair.stepName}" of the ` +
          `${ctx.repair.type} automatism. Fix that step, then call resume_automatism.`,
      });
    }
  } else {
    if (!allowedInMode(tool, ctx.planMode ?? false)) {
      return JSON.stringify({
        error: ctx.planMode
          ? `Tool "${name}" is not available while this chat is in plan mode — propose_plan instead.`
          : `Tool "${name}" needs the /plan command to be active in this chat.`,
      });
    }
    if (!tool.phases.includes(ctx.workflowPhase)) {
      return JSON.stringify({
        error: `Tool "${name}" is not allowed in the ${ctx.workflowPhase} phase.`,
      });
    }
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
