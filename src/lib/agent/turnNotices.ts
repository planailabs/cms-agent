/**
 * Turn notices — what the transcript shows when a turn ends against a guard
 * rail rather than against an answer.
 *
 * These endings used to be a sentence the server made up in the agent's voice
 * ("it required too many steps"), which reads like the agent's opinion, hides
 * the fact that a LIMIT was hit, and gives nobody a number to act on. A notice
 * is two things at once: a short plain-text `content` the model reads on the
 * next turn, and a display block the person sees as a card — what stopped, the
 * counters behind it, and what to do about it.
 */
import { tmsg } from '@/lib/i18n';
import type { DisplayBlock, NoticeFact } from '@/lib/messageBlocks';
import type { WorkflowPhase } from './types';

export interface TurnNotice {
  /** Plain text for the model (and the stored fallback for old clients). */
  content: string;
  blocks: DisplayBlock[];
}

/** What the loop did before it ran out of room. Counted by the tool loop. */
export interface RoundLimitStats {
  rounds: number;
  toolCalls: number;
  /** Tool name → times called, for the single busiest one. */
  byTool: Map<string, number>;
  /** Calls the loop detector refused to execute (identical repeats). */
  blockedRepeats: number;
  /** Distinct files written this turn. */
  filesChanged: number;
}

const fact = (key: string, value: string | number): NoticeFact => ({
  label: tmsg(key),
  value: String(value),
});

/** "read_file ×48" — the one tool that ate the turn. */
const busiest = (byTool: Map<string, number>): string | null => {
  let top: [string, number] | null = null;
  for (const entry of byTool) if (!top || entry[1] > top[1]) top = entry;
  return top ? `${top[0]} ×${top[1]}` : null;
};

export function roundLimitNotice(stats: RoundLimitStats): TurnNotice {
  const facts: NoticeFact[] = [
    fact('chat.notice.fact.rounds', stats.rounds),
    fact('chat.notice.fact.calls', stats.toolCalls),
  ];
  const top = busiest(stats.byTool);
  if (top) facts.push(fact('chat.notice.fact.busiest', top));
  // Only when it happened: a zero row invites the question "so what?".
  if (stats.blockedRepeats > 0) {
    facts.push(fact('chat.notice.fact.blocked', stats.blockedRepeats));
  }
  if (stats.filesChanged > 0) facts.push(fact('chat.notice.fact.files', stats.filesChanged));

  const body = tmsg('chat.notice.roundsBody', { rounds: stats.rounds });
  return {
    // The model gets the same facts in one line — it may have to explain the
    // stop, and it should not have to guess what happened to it.
    content:
      `I stopped after ${stats.rounds} rounds of tool calls (${stats.toolCalls} calls) ` +
      `without finishing — that is this chat's per-turn limit. ` +
      `Nothing was rolled back. Ask for a narrower piece of the work, or say "continue".`,
    blocks: [
      {
        kind: 'notice',
        tone: 'limit',
        title: tmsg('chat.notice.roundsTitle'),
        body,
        facts,
        hints: [tmsg('chat.notice.hint.narrow'), tmsg('chat.notice.hint.continue')],
      },
    ],
  };
}

const PHASE_KEY: Record<WorkflowPhase, string> = {
  plan: 'chat.notice.phase.plan',
  execute: 'chat.notice.phase.execute',
  published: 'chat.notice.phase.published',
};

export function phaseFlipNotice(runs: number, phase: WorkflowPhase): TurnNotice {
  return {
    content:
      `I switched between planning and implementing ${runs} times in this turn without ` +
      `settling, so I stopped. Tell me which part to do first.`,
    blocks: [
      {
        kind: 'notice',
        tone: 'limit',
        title: tmsg('chat.notice.pingpongTitle'),
        body: tmsg('chat.notice.pingpongBody', { runs }),
        facts: [
          fact('chat.notice.fact.switches', runs),
          { label: tmsg('chat.notice.fact.phase'), value: tmsg(PHASE_KEY[phase]) },
        ],
        hints: [tmsg('chat.notice.hint.pickOne')],
      },
    ],
  };
}
