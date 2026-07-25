import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/lib/agent/tools/registry';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(async () => ({
    data: [{ b64_json: Buffer.from('generated-png').toString('base64') }],
  })),
}));

vi.mock('openai', () => ({
  default: class {
    images = { generate: mocks.generate };
  },
}));

const { executeTool } = await import('@/lib/agent/tools/registry');
const { registerImageTools } = await import('@/lib/agent/tools/imageTools');

registerImageTools();

let repo: string;

const ctx = (phase: ToolContext['workflowPhase'] = 'execute'): ToolContext => ({
  chatId: 'image-chat',
  branchId: 'image-branch',
  branchName: 'main',
  userId: 'image-user',
  workflowPhase: phase,
  chatKind: 'workflow',
  worktreePath: repo,
  userContext: new Map(),
  modifiedPaths: new Set(),
});

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-image-tool-'));
});

describe('generate_image', () => {
  it('is execute-only, rejects escapes before generation, and writes the image', async () => {
    const input = {
      prompt: 'A quiet editorial desk in warm morning light',
      path: 'src/assets/hero.png',
      altText: 'An editorial desk in warm morning light',
    };
    expect(JSON.parse(await executeTool('generate_image', input, ctx('plan'))).error).toMatch(
      /not allowed in the plan phase/,
    );
    expect(
      JSON.parse(await executeTool('generate_image', { ...input, path: '../hero.png' }, ctx())).error,
    ).toMatch(/escapes the repository/);
    expect(mocks.generate).not.toHaveBeenCalled();

    const context = ctx();
    const result = JSON.parse(await executeTool('generate_image', input, context));
    expect(result).toMatchObject({
      success: true,
      path: input.path,
      altText: input.altText,
      bytes: 13,
    });
    expect(fs.readFileSync(path.join(repo, input.path), 'utf8')).toBe('generated-png');
    expect(context.modifiedPaths).toContain(input.path);
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-image-1', size: '1024x1024' }),
    );
  });
});
