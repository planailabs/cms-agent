/**
 * The agent's handle on the preview process: its logs and its restart.
 *
 * Both exist for the failures a file edit cannot explain. The log buffer is
 * deliberately kept in memory rather than on disk, and deliberately outlives
 * the process that wrote it — the lines worth reading are the last ones before
 * a crash, and by the time anyone asks, that server is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkSiteHealth, stopInstance } = vi.hoisted(() => ({
  checkSiteHealth: vi.fn(),
  stopInstance: vi.fn(),
}));

vi.mock('@/lib/site/health', async () => {
  const actual = await vi.importActual<typeof import('@/lib/site/health')>('@/lib/site/health');
  return { ...actual, checkSiteHealth, chatPreviewRoutes: vi.fn(async () => ['/']) };
});

import {
  appendPreviewLog,
  clearPreviewLogs,
  previewLogs,
} from '@/lib/preview/manager';
import { registerPreviewTools } from '@/lib/agent/tools/previewTools';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';

vi.mock('@/lib/preview/manager', async () => {
  const actual = await vi.importActual<typeof import('@/lib/preview/manager')>(
    '@/lib/preview/manager',
  );
  return { ...actual, stopInstance };
});

registerPreviewTools();

const BRANCH = 'c-preview-tools';

const ctx = (): ToolContext => ({
  chatId: 'preview-tools',
  branchId: 'b1',
  branchName: BRANCH,
  userId: 'u1',
  workflowPhase: 'execute',
  chatKind: 'workflow',
  worktreePath: '/tmp/wt',
  userContext: new Map(),
  modifiedPaths: new Set(),
});

const run = async (name: string, input: Record<string, unknown> = {}) =>
  JSON.parse(await executeTool(name, input, ctx()));

beforeEach(() => {
  clearPreviewLogs(BRANCH);
  checkSiteHealth.mockReset().mockResolvedValue([]);
  stopInstance.mockReset().mockResolvedValue(undefined);
});

describe('the dev-server log buffer', () => {
  it('keeps the lines the server wrote, in order, without the blank ones', () => {
    appendPreviewLog(BRANCH, 'watching for file changes...\n\n');
    appendPreviewLog(BRANCH, '[ERROR] Could not find ../components/Hero.astro\n');
    expect(previewLogs(BRANCH)).toEqual([
      'watching for file changes...',
      '[ERROR] Could not find ../components/Hero.astro',
    ]);
  });

  it('drops the oldest lines rather than growing without bound', () => {
    for (let i = 0; i < 600; i++) appendPreviewLog(BRANCH, `line ${i}\n`);
    const lines = previewLogs(BRANCH, 400);
    expect(lines).toHaveLength(400);
    // A crash prints its stack last, so the tail is the half worth keeping.
    expect(lines.at(-1)).toBe('line 599');
  });

  it('returns the tail the caller asked for', () => {
    for (let i = 0; i < 10; i++) appendPreviewLog(BRANCH, `line ${i}\n`);
    expect(previewLogs(BRANCH, 3)).toEqual(['line 7', 'line 8', 'line 9']);
  });

  it('knows nothing about a branch that never ran here', () => {
    expect(previewLogs('c-never-started')).toEqual([]);
  });
});

describe('preview_logs', () => {
  it('hands the agent the tail of what the server printed', async () => {
    appendPreviewLog(BRANCH, 'error: Unexpected token\n');
    const result = await run('preview_logs', { lines: 5 });
    expect(result.branch).toBe(BRANCH);
    expect(result.lines).toEqual(['error: Unexpected token']);
  });

  it('says why it is empty instead of implying a healthy server', async () => {
    const result = await run('preview_logs');
    expect(result.lines).toEqual([]);
    expect(result.note).toContain('restart_preview');
  });
});

describe('restart_preview', () => {
  it('stops the server and reports the site healthy once it answers again', async () => {
    const result = await run('restart_preview', { reason: 'stopped recompiling' });
    expect(stopInstance).toHaveBeenCalledWith(BRANCH);
    expect(result).toEqual({ restarted: true, healthy: true });
  });

  it('reports a restart that did not fix the site, and where to look next', async () => {
    checkSiteHealth.mockResolvedValue([
      {
        validator: 'preview-start',
        severity: 'error',
        failureClass: 'AGENT_FIXABLE',
        message: 'The preview development server for c-preview-tools does not start: boom',
      },
    ]);
    const result = await run('restart_preview', { reason: 'will not start' });
    expect(result.healthy).toBe(false);
    expect(result.errors).toContain('does not start: boom');
    expect(result.next).toContain('preview_logs');
  });
});
