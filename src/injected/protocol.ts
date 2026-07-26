/**
 * Injected-agent protocol — types shared between the workspace (parent frame)
 * and the code running inside the preview iframe.
 *
 * Transport: postMessage both ways. The bootstrap (served at
 * /injected-cms-agent.js, injected into every preview page by the proxy) is a
 * small engine that only talks to the CMS origin. The workspace pushes the
 * actual behavior in as a module (see agentModule.ts) and can evaluate
 * arbitrary code in the page via cms:eval.
 *
 *   child → parent  {type:'cms:agent-ready', url, route}
 *   parent → child  {type:'cms:load-module', id, source}   source = "(function(agent){…})" text
 *   child → parent  {type:'cms:module-loaded', id, ok, error?}
 *   parent → child  {type:'cms:eval', id, code}            code = async function body
 *   child → parent  {type:'cms:eval-result', id, ok, value?, error?}
 *   parent → child  any other cms:* message → routed to module handlers (agent.on)
 *   child → parent  any other cms:* message → routed to workspace handlers
 *
 * Element-edit mode (module/editMode.ts):
 *   parent → child  {type:'cms:edit-start', annotations?, tool?}
 *   parent → child  {type:'cms:edit-stop'|'cms:edit-undo'|'cms:edit-clear'}
 *   parent → child  {type:'cms:edit-tool', tool:'move'|'draw'|'comment'}
 *   child → parent  {type:'cms:edit-changed', annotations}   full set, every mutation
 *   child → parent  {type:'cms:edit-stopped'}                Esc inside the page
 *
 * Deliberately one-way eval: the parent evaluates code in the preview, never
 * the reverse — preview content is less trusted than the workspace.
 */

/** API handed to the pushed module and to evaluated code. */
export interface AgentApi {
  /** The CMS/workspace origin the engine talks to. */
  origin: string;
  /** Post a message to the workspace (targetOrigin pinned to the CMS origin). */
  post(msg: Record<string, unknown>): void;
  /** Handle a parent→child message type (origin/source already verified). */
  on(type: string, handler: (data: Record<string, unknown>) => void): void;
  /** Register cleanup to run before the next module replaces this one. */
  onTeardown(fn: () => void): void;
  /** Wrap a listener so an exception can never break the host page. */
  safe<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined;
}

export interface AgentEnvelope {
  type: string;
  id?: string;
  [key: string]: unknown;
}
