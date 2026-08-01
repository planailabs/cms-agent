/**
 * Abstract deployment flows (plan §7). The active flow is selected by
 * DEPLOY_FLOW; new flows register like tools/phases do.
 *
 * A flow splits its work into named `steps` — each becomes its own phase of
 * the deploy automatism (visible in the step bar, individually
 * pausable/resumable). It can also ship `tools`: extra agent tools available
 * ONLY in deployment chats of this flow (registered automatically with flow
 * scoping).
 */
import type { ToolDef } from '@/lib/agent/tools/registry';
import { registerTool } from '@/lib/agent/tools/registry';

export interface DeployInput {
  /** Exact target-branch sha being published (approval-bound). */
  sha: string;
  repoPath: string;
  /**
   * The branch this publish merged into — discovered per chat, not assumed.
   * A flow that pushes or tags must use this: a site whose default branch is
   * `master`, or a second long-lived target, would otherwise silently publish
   * `main`.
   */
  targetBranch: string;
  log: (line: string) => void;
}

export interface DeployStepInput extends DeployInput {
  /** Per-deployment scratch persisted in the automatism (survives resume). */
  state: Record<string, unknown>;
}

export interface DeployResult {
  externalUrl?: string;
  /** Flow-specific details persisted in the publication log. */
  detail?: Record<string, unknown>;
}

/** One named phase of a flow's deployment (e.g. push / build / deploy). */
export interface DeployFlowStep {
  name: string;
  /** Must be retry-safe: a resumed automatism re-runs the failed step. */
  run(input: DeployStepInput): Promise<DeployResult | void>;
}

export interface DeployFlow {
  id: string;
  /** The flow's phases, in order. At least one — a flow IS its steps. */
  steps: DeployFlowStep[];
  /** Optional post-publish verification (e.g. CI conclusion, live URL). */
  verify?(input: DeployInput, result: DeployResult): Promise<boolean>;
  /** Extra agent tools for this flow's deployment chats. */
  tools?: ToolDef[];
}

const registry = new Map<string, DeployFlow>();

export function registerDeployFlow(flow: DeployFlow): void {
  if (!flow.steps.length) throw new Error(`Deploy flow "${flow.id}" needs at least one step`);
  registry.set(flow.id, flow);
  // Flow tools live in deployment chats of THIS flow only
  for (const tool of flow.tools ?? []) {
    registerTool({ ...tool, kinds: tool.kinds ?? ['deployment'], flows: [flow.id] });
  }
}

export function getDeployFlow(id: string): DeployFlow | undefined {
  return registry.get(id);
}

export function listDeployFlows(): DeployFlow[] {
  return [...registry.values()];
}
