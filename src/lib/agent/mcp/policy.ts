/**
 * Which external MCP servers may attach to a turn, and with which tools.
 *
 * In-process tools are gated twice — toolsForPhase() when the bridge is built
 * and executeTool() on every call — but that boundary used to stop at the
 * in-process registry: external MCPs were attached and dispatched
 * independently of the workflow phase, so a mutating custom server could
 * write to the repo during the read-only PLAN phase. The sandbox contains the
 * damage to the HOST; it cannot know that PLAN means read-only. This module
 * is the missing half, and the only place the rules live.
 *
 * A server's self-declared metadata is taken at face value: readOnlyHint means
 * read-only. What is missing is not a claim, though — a tool that declares
 * nothing has said nothing, so it counts as mutating until it says otherwise.
 *
 *  - 'known'  — codebase-memory and Context7: narrowly scoped integrations we
 *    ship and configure ourselves. Attached in every phase.
 *  - 'custom' — the admin `mcp.json` servers and the branch's `.mcp.json`.
 *    Their full tool set arrives with EXECUTE. While the phase is read-only
 *    they are still attached, narrowed to the tools that declare themselves
 *    read-only: a docs search or a lookup server is exactly what planning
 *    wants, and taking the declaration at its word is what makes that
 *    possible. The gate here is the workflow phase, not trust — a
 *    repo-defined server is deliberately allowed to exist, because the site
 *    repository holds what the client themselves put there, and in production
 *    it runs behind the sandbox regardless.
 *
 * The deployment monitor observes deployments, it never changes them, so
 * every source is reduced the same way, whatever the phase says.
 *
 * The gate is the phase, never the sandbox mode: SANDBOX_MODE=none is a
 * development fallback, and the tool set must not differ between dev and
 * production, or what gets tested is not what ships.
 */
import type { ChatKind } from '../tools/registry';
import type { WorkflowPhase } from '../types';

export type McpSource = 'known' | 'custom';

export interface McpAccess {
  /** False: do not even start the server for this turn. */
  attach: boolean;
  /** Expose only tools that declare readOnlyHint. */
  readOnlyOnly: boolean;
}

export function mcpAccess(
  source: McpSource,
  ctx: { phase: WorkflowPhase; kind: ChatKind },
): McpAccess {
  // The deployments system chat is a read-only monitor, whatever its phase.
  if (ctx.kind === 'deployments') return { attach: true, readOnlyOnly: true };
  if (source === 'known') return { attach: true, readOnlyOnly: false };
  // Deployment chats resolve conflicts and commit — the handler runs them
  // with workflowPhase 'execute', so they land here with full access.
  return { attach: true, readOnlyOnly: ctx.phase !== 'execute' };
}
