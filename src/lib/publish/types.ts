/**
 * Abstract deployment flows (plan §7). The active flow is selected by
 * DEPLOY_FLOW; new flows register like tools/phases do.
 */

export interface DeployInput {
  /** Exact main sha being published (approval-bound). */
  sha: string;
  repoPath: string;
  log: (line: string) => void;
}

export interface DeployResult {
  externalUrl?: string;
  /** Flow-specific details persisted in the publication log. */
  detail?: Record<string, unknown>;
}

export interface DeployFlow {
  id: string;
  publish(input: DeployInput): Promise<DeployResult>;
  /** Optional post-publish verification (e.g. CI conclusion, live URL). */
  verify?(input: DeployInput, result: DeployResult): Promise<boolean>;
}

const registry = new Map<string, DeployFlow>();

export function registerDeployFlow(flow: DeployFlow): void {
  registry.set(flow.id, flow);
}

export function getDeployFlow(id: string): DeployFlow | undefined {
  return registry.get(id);
}
