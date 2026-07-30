/**
 * Client-side tools — pause the turn, rendered by the browser.
 * ask_question is ported from chat/'s clientTools.ts; propose_plan (explicit
 * plan mode only) and finish_execution drive the workflow-phase cards.
 */
import { z } from 'zod';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

export const askQuestionTool: ToolDef = {
  name: 'ask_question',
  description:
    'Ask the user a structured question. Use "multiple_choice" for picking from options, "text" for free-form input.',
  schema: z.object({
    type: z.enum(['multiple_choice', 'text']).describe('Question type.'),
    question: z.string().describe('The question text.'),
    options: z.array(z.string()).optional().describe('Options for multiple_choice. Omit for text.'),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
};

/** The plan payload — recorded by start_execution, or submitted for approval
 *  by propose_plan when the chat is in explicit plan mode. */
export const planSchema = z.object({
  summary: z.string().describe('One-paragraph summary of what will change and why.'),
  steps: z.array(z.string()).min(1).describe('Ordered implementation steps.'),
  files: z
    .array(
      z.object({
        path: z.string(),
        action: z.enum(['create', 'modify', 'delete']),
        reason: z.string(),
      }),
    )
    .describe('Files that will be touched.'),
  pages: z
    .array(z.object({ url: z.string(), expectedEffect: z.string() }))
    .describe('Site pages affected and how.'),
  risk: z.enum(['content', 'template', 'code', 'dependency']).describe('Highest-risk change type.'),
  questions: z.array(z.string()).optional().describe('Open questions, if any.'),
});

/**
 * Only reachable in explicit plan mode (the /plan command). Without it a plan
 * is recorded and carried out, not submitted — see chatTools.start_execution.
 */
export const proposePlanTool: ToolDef = {
  name: 'propose_plan',
  description:
    'Present the implementation plan for approval and stop. The user reviews it and ' +
    'either approves it (which starts the implementation) or asks for changes. Call ' +
    'it exactly once, when your analysis is complete.',
  schema: planSchema,
  phases: ['plan'],
  planMode: 'only',
};

export const finishExecutionTool: ToolDef = {
  name: 'finish_execution',
  description:
    'Signal that the implementation is complete and ready for review. Every change ' +
    'must already be committed with git_commit — this call is rejected while the ' +
    'worktree has uncommitted changes. The user then confirms, which settles the ' +
    'branch and puts the compare view in front of them.',
  schema: z.object({
    summary: z.string().describe('Short summary of what was implemented.'),
  }),
  phases: ['execute'],
};

export const needsHumanAttentionTool: ToolDef = {
  name: 'needs_human_attention',
  description:
    'Pause until a human performs an action you cannot do yourself (add a deploy key, ' +
    'approve access, change DNS, …). Describe precisely what they must do; the turn ' +
    'resumes when they press Done. Do not use it for questions — use ask_question.',
  schema: z.object({
    reason: z.string().describe('Why human action is required.'),
    instructions: z.string().describe('Exact steps the human should perform.'),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
};

export const pickColorTool: ToolDef = {
  name: 'pick_color',
  description:
    'Ask the user to pick a color with a visual color picker. The reply is the chosen ' +
    'color as #rrggbb. Use when a color decision is theirs to make; pass the current ' +
    'value so the picker starts from it.',
  schema: z.object({
    question: z.string().describe('What the color is for.'),
    current: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe('Current/default color as #rrggbb.'),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
};

export function registerClientTools(): void {
  registerTool(askQuestionTool);
  registerTool(pickColorTool);
  registerTool(proposePlanTool);
  registerTool(finishExecutionTool);
  registerTool(needsHumanAttentionTool);
}
