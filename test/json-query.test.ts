/** json_query — jq (wasm) over worktree files or inline content. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerJsonTools } from '@/lib/agent/tools/jsonTools';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';

registerJsonTools();

let tmp: string;

function ctx(): ToolContext {
  return {
    chatId: 'c',
    branchId: 'b',
    branchName: 'main',
    userId: 'u',
    workflowPhase: 'plan',
    chatKind: 'workflow',
    worktreePath: tmp,
    userContext: new Map(),
    modifiedPaths: new Set(),
  };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-jq-'));
  fs.mkdirSync(path.join(tmp, '.scratch'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.scratch', 'search.json'),
    JSON.stringify({ web: [{ title: 'A', url: 'https://a', score: 2 }, { title: 'B', url: 'https://b', score: 1 }] }),
  );
});

describe('json_query', () => {
  it('runs jq over a file (preferred) and inline content', async () => {
    const byFile = await executeTool(
      'json_query',
      { path: '.scratch/search.json', query: '.web | sort_by(.score) | .[].title' },
      ctx(),
    );
    expect(byFile.split('\n')).toEqual(['"B"', '"A"']);

    const inline = await executeTool(
      'json_query',
      { content: '{"a": [1, 2, 3]}', query: '[.a[] | . * 2] | add' },
      ctx(),
    );
    expect(inline).toBe('12');
  });

  it('requires exactly one of path and content', async () => {
    const neither = await executeTool('json_query', { query: '.' }, ctx());
    expect(JSON.parse(neither).error).toMatch(/exactly one/);
    const both = await executeTool(
      'json_query',
      { path: '.scratch/search.json', content: '{}', query: '.' },
      ctx(),
    );
    expect(JSON.parse(both).error).toMatch(/exactly one/);
  });

  it('surfaces jq and input errors instead of throwing', async () => {
    const badQuery = await executeTool(
      'json_query',
      { path: '.scratch/search.json', query: '.web | nosuchfn' },
      ctx(),
    );
    expect(JSON.parse(badQuery).error).toMatch(/jq failed/);

    const badJson = await executeTool('json_query', { content: 'not json', query: '.' }, ctx());
    expect(JSON.parse(badJson).error).toMatch(/Not valid JSON/);

    const missing = await executeTool(
      'json_query',
      { path: '.scratch/nope.json', query: '.' },
      ctx(),
    );
    expect(JSON.parse(missing).error).toMatch(/ENOENT|no such file/);
  });

  it('truncates oversized output', async () => {
    const big = JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => `item-${i}-xxxxxxxxxx`) });
    const out = await executeTool('json_query', { content: big, query: '.items[]' }, ctx());
    expect(out.length).toBeLessThan(51_000);
    expect(out).toContain('truncated');
  });
});
