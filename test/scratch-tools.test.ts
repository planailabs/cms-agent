/**
 * Scratchpad tools: per-chat jailed folder, writable in every phase
 * (including read-only PLAN), escape attempts rejected.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScratchTools, scratchRoot } from '@/lib/agent/tools/scratchTools';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';

registerScratchTools();

let tmp: string;

function ctx(phase: ToolContext['workflowPhase'], chatId = 'scratch-chat'): ToolContext {
  return {
    chatId,
    branchId: 'b',
    branchName: 'main',
    userId: 'u',
    workflowPhase: phase,
    chatKind: 'workflow',
    worktreePath: tmp,
    userContext: new Map(),
    modifiedPaths: new Set(),
  };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-scratch-'));
  process.env.VAR_DIR = path.join(tmp, 'var');
  const { resetEnvCache } = await import('@/lib/env');
  resetEnvCache();
});

describe('scratchpad tools', () => {
  it('writes in PLAN (read-only phase) and reads back in EXECUTE', async () => {
    const w = await executeTool(
      'scratch_write',
      { path: 'drafts/hero.md', content: '# New hero' },
      ctx('plan'),
    );
    expect(JSON.parse(w).success).toBe(true);
    // same chat, later phase — file persists
    expect(await executeTool('scratch_read', { path: 'drafts/hero.md' }, ctx('execute'))).toBe(
      '# New hero',
    );
  });

  it('edits and lists', async () => {
    await executeTool(
      'scratch_edit',
      { path: 'drafts/hero.md', oldText: 'New', newText: 'Bold' },
      ctx('plan'),
    );
    expect(await executeTool('scratch_read', { path: 'drafts/hero.md' }, ctx('plan'))).toBe(
      '# Bold hero',
    );
    expect(await executeTool('scratch_list', {}, ctx('plan'))).toContain('drafts/hero.md');
  });

  it('is isolated per chat', async () => {
    expect(await executeTool('scratch_list', {}, ctx('plan', 'other-chat'))).toBe(
      '(scratchpad is empty)',
    );
  });

  it('rejects path escapes (dotdot and absolute)', async () => {
    for (const p of ['../outside.txt', '/etc/passwd']) {
      const res = await executeTool('scratch_write', { path: p, content: 'x' }, ctx('plan'));
      expect(JSON.parse(res).error).toMatch(/escapes the scratchpad/);
    }
  });

  it('rejects symlink escapes', async () => {
    const root = scratchRoot('scratch-chat');
    fs.symlinkSync(os.tmpdir(), path.join(root, 'link'));
    const res = await executeTool(
      'scratch_write',
      { path: 'link/evil.txt', content: 'x' },
      ctx('plan'),
    );
    expect(JSON.parse(res).error).toMatch(/escapes the scratchpad/);
  });

  it('deletes', async () => {
    await executeTool('scratch_delete', { path: 'drafts/hero.md' }, ctx('plan'));
    const res = await executeTool('scratch_read', { path: 'drafts/hero.md' }, ctx('plan'));
    expect(JSON.parse(res).error).toBeTruthy();
  });
});
