/**
 * Client-side tools — pause the turn, rendered by the browser.
 * ask_question is ported from chat/'s clientTools.ts; propose_plan and
 * finish_execution drive the workflow-phase cards.
 */
import { z } from 'zod';
import { registerTool, type ToolDef } from './registry';

export const askQuestionTool: ToolDef = {
  name: 'ask_question',
  description:
    'Ask the user a structured question. Use "multiple_choice" for picking from options, "text" for free-form input.',
  schema: z.object({
    type: z.enum(['multiple_choice', 'text']).describe('Question type.'),
    question: z.string().describe('The question text.'),
    options: z.array(z.string()).optional().describe('Options for multiple_choice. Omit for text.'),
  }),
  phases: ['plan', 'execute', 'preview', 'published'],
  kinds: ['workflow', 'deployments'],
};

export const proposePlanTool: ToolDef = {
  name: 'propose_plan',
  description:
    'Present the implementation plan for approval. Call this exactly once when your analysis is complete. The user reviews it and either approves (moving to execution) or requests changes.',
  schema: z.object({
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
  }),
  phases: ['plan'],
};

export const finishExecutionTool: ToolDef = {
  name: 'finish_execution',
  description:
    'Signal that the implementation is complete and ready for preview. The user confirms; the CMS then commits all changes as one commit and switches to the preview phase.',
  schema: z.object({
    summary: z.string().describe('Short summary of what was implemented (used as commit message).'),
  }),
  phases: ['execute'],
};

export function registerClientTools(): void {
  registerTool(askQuestionTool);
  registerTool(proposePlanTool);
  registerTool(finishExecutionTool);
}
