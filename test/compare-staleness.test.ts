/**
 * Compare shots go stale the moment the agent touches the site.
 *
 * The cache key is (route, main sha, branch sha), which is exactly right until
 * an EXECUTE turn starts: it writes for minutes before it commits anything,
 * and both shas stay where they were the whole time. Without a third input the
 * compare view keeps answering from the cache and shows a page that no longer
 * exists — and the browser, told to cache shots for five minutes, does the
 * same on its own. So the branch carries a generation, it is part of the key
 * AND of the URL, and everything that changes the site bumps it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareGeneration, markComparePreviewsOutdated } from '@/lib/diff/screenshot';
import { applyCompareStale } from '@/components/workspace/compareStale';
import { createInitialWorkspaceState } from '@/components/workspace/state';
import { store } from '@/components/chat/app/store';

const cacheDir = (branch: string) => path.join(os.tmpdir(), 'cms-agent-diffs', branch);

describe('the compare generation', () => {
  it('starts at zero and advances once per change', () => {
    const branch = `c-gen-${Math.random().toString(16).slice(2)}`;
    expect(compareGeneration(branch)).toBe(0);
    expect(markComparePreviewsOutdated(branch)).toBe(1);
    expect(markComparePreviewsOutdated(branch)).toBe(2);
    expect(compareGeneration(branch)).toBe(2);
  });

  it('is per branch — one chat working does not invalidate another', () => {
    const a = `c-gen-a-${Math.random().toString(16).slice(2)}`;
    const b = `c-gen-b-${Math.random().toString(16).slice(2)}`;
    markComparePreviewsOutdated(a);
    expect(compareGeneration(a)).toBe(1);
    expect(compareGeneration(b)).toBe(0);
  });

  it('throws away the shots it just declared outdated', () => {
    const branch = `c-gen-files-${Math.random().toString(16).slice(2)}`;
    const dir = cacheDir(branch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc-before.png'), 'stale bytes');

    markComparePreviewsOutdated(branch);
    // They can never be served again — leaving them in TMPDIR until a restart
    // is pure disk cost.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('survives a branch that was never captured', () => {
    expect(() => markComparePreviewsOutdated('c-never-captured')).not.toThrow();
  });
});

describe('the client reacting to compare_stale', () => {
  const setup = (window: 'compare' | null) => {
    store.state.workspace = createInitialWorkspaceState();
    store.state.workspace.window = window;
    store.state.workspace.diff.loaded = true;
    store.state.workspace.diff.generation = 3;
    return store.state.workspace;
  };

  it('takes the new generation, which is what re-dates every shot URL', () => {
    const ws = setup('compare');
    applyCompareStale(7);
    expect(ws.diff.generation).toBe(7);
  });

  it('ignores an older number, so a late event cannot un-stale the view', () => {
    const ws = setup('compare');
    applyCompareStale(1);
    expect(ws.diff.generation).toBe(3);
  });

  it('does not capture screenshots for a compare window nobody has open', () => {
    const ws = setup(null);
    applyCompareStale(9);
    // Marked for reload instead: opening it fetches the pages and the shots
    // that go with them.
    expect(ws.diff.loaded).toBe(false);
    expect(ws.diff.generation).toBe(9);
  });
});
