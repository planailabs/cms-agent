/**
 * Capability router — a small model (SKILL_ROUTER_MODEL) reads the skill index
 * and the MCP group index at turn start and names the ones this turn is likely
 * to want. The system prompt then carries those instead of everything; the
 * rest stays one query_skills / query_mcps call away.
 *
 * It has no fallback on purpose. If the router is down, the alternative is a
 * prompt that quietly grows back to every skill in the install — the exact
 * cost this exists to remove, and invisible from the outside. So a failure
 * fails the turn, the same way a failed model request already does, and the
 * user gets the error banner with Retry.
 */
import OpenAI from 'openai';
import { env } from '@/lib/env';
import { countTokens } from '@/lib/metrics';
import type { PluginSkill } from './plugins';
import type { McpGroupView } from './mcp/groups';
import { bestMatches } from './capabilityIndex';
import type { ChatKind } from './tools/registry';
import type { StoredMessage, WorkflowPhase } from './types';

export interface RouterInput {
  chatId: string;
  messages: StoredMessage[];
  skills: PluginSkill[];
  groups: McpGroupView[];
  phase: WorkflowPhase;
  kind: ChatKind;
}

export interface RouterVerdict {
  skills: string[];
  groups: string[];
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM = `You route an editorial CMS agent's capabilities. Given the user's recent messages and two indexes — available SKILLS and loadable MCP GROUPS — name everything that turn could plausibly need.

Rules:
- Answer with JSON only: {"skills":["name",…],"groups":["id",…]}. No prose, no code fence.
- Use names exactly as listed. Never invent one.
- Be generous. Include anything that MIGHT apply, not only what certainly does: a skill costs one line in the prompt when it turns out to be irrelevant, but a skill you leave out is one the agent never learns exists. When you hesitate over an entry, include it.
- Think past the literal request to the work it implies — editing a page usually also means checking how it looks, publishing usually also means deploying — and include the skills and groups for those steps too.
- Naming an MCP group does NOT load it: you are listing candidates the agent may load if it needs them, so the cost of naming one is a line of text.
- Only leave a list empty when the index genuinely has nothing related.`;

/** Keyword matches added on top of the model's picks, per index. */
const KEYWORD_TOPUP = 3;
const MAX_MESSAGE_CHARS = 1500;
const RECENT_USER_MESSAGES = 3;

/** The recent human input, which is what the routing decision is about. */
function recentUserText(messages: StoredMessage[]): string {
  // Tool-result rows carry no prose; everything else has a `content` string.
  const texts = messages
    .filter((m) => m.role !== 'tool')
    .map((m) => ({ role: m.role, content: (m as { content: string }).content }));
  const users = texts.filter((m) => m.role === 'user').slice(-RECENT_USER_MESSAGES);
  const source = users.length > 0 ? users : texts.slice(-RECENT_USER_MESSAGES);
  return source.map((m) => m.content.slice(0, MAX_MESSAGE_CHARS)).join('\n---\n');
}

const skillLines = (skills: PluginSkill[]): string =>
  skills.map((s) => `- ${s.name}: ${s.description.slice(0, 200)}`).join('\n') || '(none)';

const groupLines = (groups: McpGroupView[]): string =>
  groups
    .map(
      (g) =>
        `- ${g.id}${g.loaded ? ' (already loaded)' : ''}: ${g.description.slice(0, 200)}` +
        (g.servers.length > 1 ? ` [servers: ${g.servers.join(', ')}]` : ''),
    )
    .join('\n') || '(none)';

/** Strings from a parsed answer, filtered to what the index actually offers. */
function pick(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const byLower = new Map([...allowed].map((a) => [a.toLowerCase(), a]));
  const out = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const match = byLower.get(v.trim().toLowerCase());
    if (match) out.add(match);
  }
  return [...out];
}

/** Same turn, same routing: a phase flip restarts the run, not the decision. */
const memo = new Map<string, RouterVerdict>();
const memoKey = (input: RouterInput): string =>
  `${input.chatId}:${input.messages.length}:${input.skills.length}:${input.groups.length}`;

export function resetRouterMemo(): void {
  memo.clear();
}

export async function routeCapabilities(input: RouterInput): Promise<RouterVerdict> {
  const cached = memo.get(memoKey(input));
  // Only the first run of a turn pays; the replay reports no tokens.
  if (cached) return { ...cached, inputTokens: 0, outputTokens: 0 };

  const e = env();
  const openai = new OpenAI({ baseURL: e.OPENAI_BASE_URL, apiKey: e.OPENAI_API_KEY });
  const user =
    `Chat kind: ${input.kind}. Workflow phase: ${input.phase}.\n\n` +
    `SKILLS:\n${skillLines(input.skills)}\n\n` +
    `MCP GROUPS:\n${groupLines(input.groups)}\n\n` +
    `RECENT USER MESSAGES:\n${recentUserText(input.messages)}`;

  let inputTokens = 0;
  let outputTokens = 0;
  let parsed: { skills?: unknown; groups?: unknown } | null = null;
  let lastRaw = '';

  // One retry: a small model occasionally wraps the object in prose, and
  // re-asking is cheaper than failing a turn over a stray sentence.
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    const completion = await openai.chat.completions.create({
      model: e.SKILL_ROUTER_MODEL,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
        ...(attempt === 1
          ? []
          : ([
              { role: 'assistant', content: lastRaw.slice(0, 500) },
              { role: 'user', content: 'That was not JSON. Answer with the JSON object only.' },
            ] as const)),
      ],
    });
    inputTokens += completion.usage?.prompt_tokens ?? 0;
    outputTokens += completion.usage?.completion_tokens ?? 0;
    countTokens(
      e.SKILL_ROUTER_MODEL,
      completion.usage?.prompt_tokens ?? 0,
      completion.usage?.completion_tokens ?? 0,
    );
    lastRaw = completion.choices[0]?.message.content?.trim() ?? '';
    const json = lastRaw.replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      const value: unknown = JSON.parse(json);
      if (value && typeof value === 'object') parsed = value as { skills?: unknown; groups?: unknown };
    } catch {
      // retry once, then throw below
    }
  }

  if (!parsed) {
    throw new Error(
      `Capability router (${e.SKILL_ROUTER_MODEL}) returned no usable JSON: ${lastRaw.slice(0, 200) || '(empty)'}`,
    );
  }

  // The model's picks, plus what plain keyword overlap says is relevant. The
  // union is the optimistic half: a small model that overlooks the skill whose
  // name is in the user's own sentence should not be the reason the agent
  // never sees it. Duplicates collapse; misses cost nothing but a line.
  const text = recentUserText(input.messages);
  const skills = new Set(pick(parsed.skills, new Set(input.skills.map((s) => s.name))));
  for (const s of bestMatches(text, input.skills, (x) => ({ title: x.name, body: x.description }), KEYWORD_TOPUP)) {
    skills.add(s.name);
  }
  const groups = new Set(pick(parsed.groups, new Set(input.groups.map((g) => g.id))));
  for (const g of bestMatches(
    text,
    input.groups,
    (x) => ({ title: `${x.id} ${x.servers.join(' ')}`, body: x.description }),
    KEYWORD_TOPUP,
  )) {
    groups.add(g.id);
  }

  const verdict: RouterVerdict = {
    skills: [...skills],
    groups: [...groups],
    inputTokens,
    outputTokens,
  };
  memo.set(memoKey(input), verdict);
  console.log(
    `[router] chat=${input.chatId} skills=${verdict.skills.join(',') || '-'} groups=${verdict.groups.join(',') || '-'}`,
  );
  return verdict;
}
