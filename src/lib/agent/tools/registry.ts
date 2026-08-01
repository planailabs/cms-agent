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

/**
 * Why a tool is not available. The two enforcement points — hiding a tool
 * from the model and refusing a call to it — are deliberately separate (a
 * hallucinated call must fail even though the tool was never offered), but
 * they must never disagree about WHAT is allowed. This is the one predicate
 * both ask; only the wording of the refusal belongs to the executor.
 */
export type ToolRefusal = 'kind' | 'flow' | 'repair' | 'planMode' | 'phase';

/** Everything the policy looks at, without the rest of a turn's context. */
export interface ToolScope {
  workflowPhase: WorkflowPhase;
  chatKind: ChatKind;
  deployFlowId?: string;
  planMode: boolean;
  /** A repair turn: the paused step's own set REPLACES the phase and
   *  plan-mode gates (see toolsForTurn). Chat-kind and flow scoping still
   *  apply — a repair cannot reach tools that chat kind never has. */
  repairTools?: ReadonlySet<string>;
}

/** null = available. */
export function toolRefusal(tool: ToolDef, scope: ToolScope): ToolRefusal | null {
  if (!(tool.kinds ?? ['workflow']).includes(scope.chatKind)) return 'kind';
  if (tool.flows && (scope.deployFlowId == null || !tool.flows.includes(scope.deployFlowId))) {
    return 'flow';
  }
  if (scope.repairTools) return scope.repairTools.has(tool.name) ? null : 'repair';
  if (!allowedInMode(tool, scope.planMode)) return 'planMode';
  if (!tool.phases.includes(scope.workflowPhase)) return 'phase';
  return null;
}

const availableIn = (scope: ToolScope): ToolDef[] =>
  [...registry.values()].filter((t) => toolRefusal(t, scope) === null);

export function toolsForPhase(
  phase: WorkflowPhase,
  kind: ChatKind = 'workflow',
  deployFlowId?: string,
  planMode = false,
): ToolDef[] {
  return availableIn({ workflowPhase: phase, chatKind: kind, deployFlowId, planMode });
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
  return availableIn(scopeOf(ctx));
}

/** The policy view of a turn. */
const scopeOf = (ctx: ToolContext): ToolScope => ({
  workflowPhase: ctx.workflowPhase,
  chatKind: ctx.chatKind,
  deployFlowId: ctx.deployFlowId,
  planMode: ctx.planMode ?? false,
  repairTools: ctx.repair?.tools,
});

const allowedInMode = (tool: ToolDef, planMode: boolean): boolean =>
  tool.planMode === 'only' ? planMode : tool.planMode === 'never' ? !planMode : true;

export function isClientSideTool(name: string): boolean {
  const t = registry.get(name);
  return !!t && !t.execute;
}

/** Each refusal says what is wrong AND what to do instead — a bare "not
 *  allowed" makes the model retry the same call. */
function refusalMessage(reason: ToolRefusal, name: string, ctx: ToolContext): string {
  switch (reason) {
    case 'kind':
      return `Tool "${name}" is not available in this chat.`;
    case 'flow':
      return `Tool "${name}" belongs to another deploy flow.`;
    case 'repair':
      return (
        `Tool "${name}" is not part of repairing step "${ctx.repair?.stepName}" of the ` +
        `${ctx.repair?.type} automatism. Fix that step, then call resume_automatism.`
      );
    case 'planMode':
      return ctx.planMode
        ? `Tool "${name}" is not available while this chat is in plan mode — propose_plan instead.`
        : `Tool "${name}" needs the /plan command to be active in this chat.`;
    case 'phase':
      return `Tool "${name}" is not allowed in the ${ctx.workflowPhase} phase.`;
  }
}

/**
 * Execute a server-side tool with the same gating that decided its exposure —
 * a tool outside the current phase is rejected even if the model hallucinated
 * it.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  // Same predicate that decided whether to offer the tool at all — a
  // hallucinated call is refused here, in the words that tell the model what
  // to do instead. (A repair turn is authorized by its step, not the phase.)
  const refusal = toolRefusal(tool, scopeOf(ctx));
  if (refusal) return JSON.stringify({ error: refusalMessage(refusal, name, ctx) });
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
