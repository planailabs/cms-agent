/**
 * Exposure and execution must never disagree about what a tool is allowed to
 * do.
 *
 * They are deliberately two enforcement points — a hallucinated call has to
 * fail even though the tool was never offered — but they used to encode the
 * chat-kind, flow, plan-mode and phase rules separately, which is a security
 * policy waiting to drift. Both now ask one predicate; this test is what
 * fails if a future change teaches only one of them a new rule.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  executeTool,
  registerTool,
  toolsForTurn,
  type ToolContext,
} from '@/lib/agent/tools/registry';
import { ALL_PHASES } from '@/lib/agent/types';

/** Purpose-built tools rather than real ones: this must exercise the policy,
 *  not run a deploy. Each carries exactly one restriction. */
const NAMES = [
  'parity_open', // no restriction at all
  'parity_execute_only', // one phase
  'parity_deployment', // one chat kind
  'parity_flowed', // one deploy flow
  'parity_plan_only', // /plan only
  'parity_plan_never', // hidden in /plan
] as const;

registerTool({
  name: 'parity_open',
  description: 't',
  schema: z.object({}),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
  execute: async () => 'ran',
});
registerTool({
  name: 'parity_execute_only',
  description: 't',
  schema: z.object({}),
  phases: ['execute'],
  execute: async () => 'ran',
});
registerTool({
  name: 'parity_deployment',
  description: 't',
  schema: z.object({}),
  phases: ALL_PHASES,
  kinds: ['deployment'],
  execute: async () => 'ran',
});
registerTool({
  name: 'parity_flowed',
  description: 't',
  schema: z.object({}),
  phases: ALL_PHASES,
  kinds: ['deployment'],
  flows: ['parity-flow'],
  execute: async () => 'ran',
});
registerTool({
  name: 'parity_plan_only',
  description: 't',
  schema: z.object({}),
  phases: ALL_PHASES,
  planMode: 'only',
  execute: async () => 'ran',
});
registerTool({
  name: 'parity_plan_never',
  description: 't',
  schema: z.object({}),
  phases: ALL_PHASES,
  planMode: 'never',
  execute: async () => 'ran',
});

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  chatId: 'parity',
  branchId: 'b1',
  branchName: 'c-parity',
  userId: 'u1',
  workflowPhase: 'plan',
  chatKind: 'workflow',
  worktreePath: '/tmp/wt',
  userContext: new Map(),
  modifiedPaths: new Set(),
  ...over,
});

/** Every combination that the policy distinguishes. */
const SCOPES: Array<[string, ToolContext]> = [
  ['plan/workflow', ctx()],
  ['execute/workflow', ctx({ workflowPhase: 'execute' })],
  ['published/workflow', ctx({ workflowPhase: 'published' })],
  ['plan-mode', ctx({ planMode: true })],
  ['deployment chat', ctx({ chatKind: 'deployment' })],
  ['deployment chat of the flow', ctx({ chatKind: 'deployment', deployFlowId: 'parity-flow' })],
  ['deployment chat of another flow', ctx({ chatKind: 'deployment', deployFlowId: 'other' })],
  ['deployments monitor', ctx({ chatKind: 'deployments' })],
  [
    'repair turn',
    ctx({
      repair: {
        automatismId: 'a1',
        type: 'parity',
        step: 0,
        stepName: 'step',
        tools: new Set(['parity_execute_only']),
      },
    }),
  ],
];

describe('tool availability', () => {
  it.each(SCOPES)('agrees between exposure and execution in %s', async (_label, c) => {
    const exposed = new Set(toolsForTurn(c).map((t) => t.name));
    for (const name of NAMES) {
      const result = await executeTool(name, {}, c);
      if (exposed.has(name)) {
        // Offered → it runs. Anything else means the executor knows a rule
        // the exposure filter does not.
        expect({ name, result }).toEqual({ name, result: 'ran' });
      } else {
        // Not offered → refused, and the refusal explains itself.
        const error = JSON.parse(result).error as string | undefined;
        expect({ name, error: !!error }).toEqual({ name, error: true });
        expect(error).toContain(name);
      }
    }
  });

  it('grants a repair exactly its step tools, whatever the phase allows', () => {
    const c = SCOPES.find(([l]) => l === 'repair turn')![1];
    const exposed = toolsForTurn(c)
      .map((t) => t.name)
      .filter((n) => n.startsWith('parity_'));
    // The chat is in PLAN, where parity_execute_only is normally invisible.
    expect(exposed).toEqual(['parity_execute_only']);
    expect(toolsForTurn(ctx()).map((t) => t.name)).not.toContain('parity_execute_only');
  });
});
