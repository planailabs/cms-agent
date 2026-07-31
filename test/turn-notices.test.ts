/**
 * Guard-rail endings.
 *
 * A turn can end because the model answered, or because it hit a limit. The
 * second case used to be a sentence written in the agent's voice ("it required
 * too many steps") — which reads like an opinion, hides that a LIMIT was the
 * cause, and gives nobody a number to act on. It is now a card: what stopped,
 * the counters behind it, and what the person can do next.
 */
import { describe, expect, it } from 'vitest';
import { phaseFlipNotice, roundLimitNotice } from '@/lib/agent/turnNotices';
import { normalizeBlocks, blockEnvelope } from '@/lib/messageBlocks';
import { renderMessageBlocks } from '@/components/chat/ui/chat/blocks';
import { renderMessageBubbles } from '@/components/chat/ui/chat/bubbles';
import { resolveTranslated } from '@/lib/i18n';

const stats = (over: Partial<Parameters<typeof roundLimitNotice>[0]> = {}) =>
  roundLimitNotice({
    rounds: 250,
    toolCalls: 612,
    byTool: new Map([
      ['read_file', 480],
      ['write_file', 12],
    ]),
    blockedRepeats: 7,
    filesChanged: 3,
    ...over,
  });

describe('the round-limit notice', () => {
  it('says which limit was hit, in numbers', () => {
    const notice = stats();
    const block = notice.blocks[0];
    if (block.kind !== 'notice') throw new Error('expected a notice block');

    expect(block.tone).toBe('limit');
    const values = block.facts!.map((f) => f.value);
    expect(values).toContain('250');
    expect(values).toContain('612');
    // The one tool that ate the turn — the actionable part of "too many steps".
    expect(values).toContain('read_file ×480');
    expect(values).toContain('7');
    expect(values).toContain('3');
  });

  it('leaves out counters that did not happen', () => {
    const notice = stats({ blockedRepeats: 0, filesChanged: 0 });
    const block = notice.blocks[0];
    if (block.kind !== 'notice') throw new Error('expected a notice block');
    // A row reading "Repeats blocked: 0" only invites the question "so what?".
    expect(block.facts!.map((f) => f.value)).not.toContain('0');
    expect(block.facts).toHaveLength(3);
  });

  it('tells the MODEL the same thing in plain text', () => {
    // It may have to explain the stop on the next turn, so it must not have to
    // guess what happened to it.
    const content = stats().content;
    expect(content).toContain('250');
    expect(content).toContain('612');
    expect(content).not.toContain('<');
  });
});

describe('the plan/execute ping-pong notice', () => {
  it('reports the number of switches and where it ended', () => {
    const notice = phaseFlipNotice(4, 'execute');
    const block = notice.blocks[0];
    if (block.kind !== 'notice') throw new Error('expected a notice block');
    expect(block.facts!.map((f) => f.value)).toContain('4');
    // The phase is a word, so it travels as a TranslatedMessage, not a string.
    const phase = block.facts![1].value;
    expect(typeof phase).not.toBe('string');
    expect(resolveTranslated('de', phase as never)).toBe('Umsetzung');
    expect(block.hints).toHaveLength(1);
  });
});

describe('the card in the transcript', () => {
  it('renders title, explanation, facts and what to do', () => {
    const html = renderMessageBlocks(stats().blocks);
    expect(html).toContain('msg-card--notice');
    expect(html).toContain('The agent ran out of steps');
    expect(html).toContain('250 rounds of tool calls');
    expect(html).toContain('Rounds');
    expect(html).toContain('read_file ×480');
    expect(html).toContain('msg-card__hints');
    expect(html).toContain('continue');
  });

  it('survives storage and speaks the viewer’s language', () => {
    // The blocks go through the same envelope as every other kind.
    const stored = normalizeBlocks(blockEnvelope(stats().blocks));
    expect(stored).toHaveLength(1);
    const block = stored[0];
    if (block.kind !== 'notice') throw new Error('expected a notice block');
    expect(resolveTranslated('de', block.title)).toBe('Dem Agenten sind die Schritte ausgegangen');
    expect(resolveTranslated('de', block.body)).toContain('250 Runden');
  });

  it('replaces the agent-voiced sentence rather than sitting under it', () => {
    const notice = stats();
    const html = renderMessageBubbles({
      phase: 'idle',
      messages: [{ role: 'assistant', content: notice.content, blocks: notice.blocks }],
    } as never);
    expect(html).toContain('msg-card--notice');
    // The prose is what the MODEL reads; showing both says it twice.
    expect(html).not.toContain('I stopped after');
  });

  it('survives the shared column: stored, then read back by /history', async () => {
    // Risk being covered: an assistant row's contentBlocks normally holds its
    // TOOL CALLS. A notice puts a block envelope in the same column, and the
    // reader must tell the two apart instead of iterating an object as calls.
    const { prisma } = await import('@/lib/db');
    const { createDbAdapter } = await import('@/lib/agent/persistence');
    const { GET: historyGet } = await import('@/pages/api/chat/history');

    const branch = await prisma.branch.upsert({
      where: { name: 'notice-test-target' },
      create: { name: 'notice-test-target' },
      update: {},
    });
    const chat = await prisma.chat.create({
      data: { branchId: branch.id, workBranch: `c-notice-${Date.now()}` },
    });
    const adapter = createDbAdapter(chat.id, null, [], { value: 0 });
    const notice = stats();
    await adapter.appendMsg({ role: 'user', content: 'do everything' });
    // An ordinary tool-calling assistant row, so both shapes are in one chat.
    await adapter.appendMsg({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    } as never);
    await adapter.appendMsg({ role: 'tool', results: [{ toolCallId: 'call_1', content: 'ok' }] });
    await adapter.appendMsg({ role: 'assistant', content: notice.content, blocks: notice.blocks });

    const res = await historyGet({
      url: new URL(`http://localhost/api/chat/history?chatId=${chat.id}`),
      locals: { user: { id: 'u-test-admin', role: 'admin' } },
    } as never);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    const withBlocks = body.messages.filter((m) => Array.isArray(m.blocks));
    expect(withBlocks).toHaveLength(1);
    expect((withBlocks[0].blocks as Array<{ kind: string }>)[0].kind).toBe('notice');
    // The tool-calling row still produces its tool line — nothing was confused.
    expect(body.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('leaves an ordinary assistant message as prose', () => {
    const html = renderMessageBubbles({
      phase: 'idle',
      messages: [{ role: 'assistant', content: 'Added the heading.' }],
    } as never);
    expect(html).toContain('Added the heading.');
    expect(html).not.toContain('msg-card--notice');
  });
});
