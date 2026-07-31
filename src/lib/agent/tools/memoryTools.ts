/**
 * propose_memory — the agent suggests a project convention; an editor must
 * approve it in the UI before it enters the system prompt (medved §23).
 */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { broadcast } from '../bus';
import { memoryContentAllowed } from '@/lib/memory';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

const proposeMemoryTool: ToolDef = {
  name: 'propose_memory',
  description:
    'Propose a reusable project convention you discovered or the team confirmed (naming, frontmatter rules, tone). It only takes effect after an editor approves it. Secrets and approval rules are never learnable.',
  schema: z.object({
    content: z.string().describe('The convention, one concise sentence or rule.'),
    source: z.string().describe('Where this came from (file, conversation, observation).'),
    reason: z.string().describe('Why this is worth remembering.'),
  }),
  phases: ALL_PHASES,
  async execute(input, ctx) {
    const denied = memoryContentAllowed(input.content);
    if (denied) return JSON.stringify({ error: denied });
    const candidate = await prisma.memoryCandidate.create({
      data: { chatId: ctx.chatId, content: input.content, source: input.source, reason: input.reason },
    });
    return JSON.stringify({ success: true, candidateId: candidate.id, status: 'pending approval' });
  },
};

export function registerMemoryTools(): void {
  registerTool(proposeMemoryTool);
}
