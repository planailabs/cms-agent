/**
 * Automatism tools — resume_automatism lets the agent (after fixing the
 * cause of a failed step) re-run that step and continue the flow. Available
 * in every chat kind; only acts when a paused automatism is reachable from
 * this chat (its home chat or the chat the agent was invoked in).
 */
import { z } from 'zod';
import { findPausedAutomatism, resumeAutomatism } from '@/lib/automatism';
import { registerTool } from './registry';
import { ALL_PHASES } from '../types';

export function registerAutomatismTools(): void {
  registerTool({
    name: 'resume_automatism',
    description:
      'Resume the paused automatism (agent-less flow, e.g. the deploy pipeline) tied to this ' +
      'chat: the failed step re-runs and the flow continues. Call this ONLY after the cause ' +
      'of the failure is actually fixed. Progress arrives as [Automatism] events.',
    schema: z.object({}),
    phases: ALL_PHASES,
    kinds: ['workflow', 'deployment', 'deployments'],
    execute: async (_input, ctx) => {
      await import('@/lib/publish/publisher'); // ensures automatism types are registered
      const paused = await findPausedAutomatism(ctx.chatId);
      if (!paused) {
        return JSON.stringify({ error: 'No paused automatism is tied to this chat.' });
      }
      const ok = await resumeAutomatism(paused.id);
      if (!ok) return JSON.stringify({ error: 'The automatism is no longer paused.' });
      return JSON.stringify({
        ok: true,
        resumed: paused.type,
        step: paused.step,
        note: 'The flow continues in the background; progress arrives as automatism events.',
      });
    },
  });
}
