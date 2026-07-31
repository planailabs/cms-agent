/**
 * A paused automatism brings its own tools.
 *
 * The repair turn used to get whatever the chat's workflow phase granted,
 * which is the wrong question twice over: a chat mid-PLAN cannot write, so the
 * flow moved it into EXECUTE by force (and owed it a restore afterwards), and
 * a repair that only needs to read a deploy log got the whole editing surface
 * anyway. The failed STEP knows what its repair needs; nothing else does.
 */
import { describe, expect, it } from 'vitest';
import {
  REPAIR_CORE_TOOLS,
  registerAutomatism,
  repairToolsFor,
  type RepairContext,
} from '@/lib/automatism';
import { executeTool, toolsForTurn, type ToolContext } from '@/lib/agent/tools/registry';
import '@/lib/publish/publisher'; // registers the real flows

registerAutomatism({
  type: 'repair-tools-test',
  steps: [
    { name: 'declares', repairTools: ['write_file', 'git_commit'], run: async () => {} },
    { name: 'declares-nothing', run: async () => {} },
  ],
});

const repair = (type: string, step: number): RepairContext => {
  const tools = repairToolsFor(type, step);
  if (!tools) throw new Error('step declares no repair tools');
  return { automatismId: 'a1', type, step, stepName: 'step', tools };
};

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  chatId: 'repair-tools',
  branchId: 'b1',
  branchName: 'c-repair',
  userId: 'u1',
  workflowPhase: 'plan',
  chatKind: 'workflow',
  worktreePath: '/tmp/wt',
  userContext: new Map(),
  modifiedPaths: new Set(),
  ...over,
});

describe('the tools a repair brings', () => {
  it('adds the common core to what the step declares', () => {
    const tools = repairToolsFor('repair-tools-test', 0)!;
    expect(tools.has('write_file')).toBe(true);
    for (const core of REPAIR_CORE_TOOLS) expect(tools.has(core)).toBe(true);
  });

  it('is null for a step that declares none — then the phase decides, as before', () => {
    expect(repairToolsFor('repair-tools-test', 1)).toBeNull();
    expect(repairToolsFor('no-such-type', 0)).toBeNull();
  });

  it('replaces the phase tool set rather than extending it', () => {
    const plain = toolsForTurn(ctx()).map((t) => t.name);
    const repaired = toolsForTurn(ctx({ repair: repair('repair-tools-test', 0) })).map((t) => t.name);

    // The planning surface is not what a repair is for.
    expect(plain).toContain('start_execution');
    expect(repaired).not.toContain('start_execution');
    expect(repaired).toContain('write_file');
    expect(repaired.length).toBeLessThan(plain.length);
  });

  it('authorizes the writes it asked for without moving the chat to EXECUTE', async () => {
    // write_file is exposed in every phase and gated at execution time, so the
    // repair has to be recognized there too — otherwise the flow would have to
    // shove the chat into EXECUTE to let a conflict be resolved.
    const planning = ctx({ workflowPhase: 'plan' });
    const refused = JSON.parse(
      await executeTool('write_file', { path: 'src/pages/x.astro', content: 'x' }, planning),
    );
    expect(refused.error).toContain('.scratch/');

    const repairing = ctx({ workflowPhase: 'plan', repair: repair('pull', 0) });
    const allowed = JSON.parse(
      await executeTool('write_file', { path: 'src/pages/x.astro', content: 'x' }, repairing),
    );
    // Past the phase gate: whatever it says now is about the worktree, which
    // this test does not have — the refusal above is the thing being ruled out.
    expect(allowed.error ?? '').not.toContain('.scratch/');
  });

  it('lets a conflict repair write while the chat stays in PLAN', () => {
    const names = toolsForTurn(ctx({ repair: repair('pull', 0) })).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_conflicts', 'edit_file', 'git_commit']));
    expect(names).toContain('resume_automatism');
  });

  it('keeps a deploy repair read-only about the site', () => {
    const names = toolsForTurn(
      ctx({ chatKind: 'deployment', workflowPhase: 'execute', repair: repair('deploy', 2) }),
    ).map((t) => t.name);
    expect(names).toContain('get_publication');
    // A deploy that failed to push is not fixed by editing pages.
    expect(names).not.toContain('write_file');
  });

  it('refuses a tool the step did not ask for, whatever the phase allows', async () => {
    const c = ctx({ workflowPhase: 'execute', repair: repair('repair-tools-test', 0) });
    const result = JSON.parse(await executeTool('remove_file', { path: 'src/pages/index.astro' }, c));
    expect(result.error).toContain('not part of repairing step');
    expect(result.error).toContain('resume_automatism');
  });

  it('still refuses a tool that chat kind never has', () => {
    // The repair set is not a way around the kind boundary: the deployments
    // monitor owns no worktree, so no declaration can hand it the file tools.
    const names = toolsForTurn(
      ctx({ chatKind: 'deployments', repair: repair('repair-tools-test', 0) }),
    ).map((t) => t.name);
    expect(names).not.toContain('write_file');
    expect(names).toContain('resume_automatism');
  });
});
