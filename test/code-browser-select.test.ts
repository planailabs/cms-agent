/**
 * Code-browser multi-line selection: drag ranges, shift-extend, reverse
 * drags, and single-line deselect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@/components/chat/app/store';
import { createInitialWorkspaceState } from '@/components/workspace/state';
import {
  beginLineSelect,
  dragLineSelect,
  endLineSelect,
  openCodeBrowser,
  openFile,
  workFileTarget,
} from '@/components/workspace/codeBrowser';

const sel = () => {
  const cb = store.state.workspace.codeBrowser;
  return [cb.selStart, cb.selEnd];
};

beforeEach(() => {
  store.state.workspace = createInitialWorkspaceState();
  endLineSelect();
});

afterEach(() => vi.unstubAllGlobals());

describe('code browser line selection', () => {
  it('loads the tree and linked file independently', async () => {
    store.state.activeChatId = 'chat';
    store.state.workspace.codeBrowser.expanded = ['src'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const path = new URL(input, 'http://localhost').searchParams.get('path');
        return {
          ok: true,
          json: async () =>
            path === 'src/file.ts'
              ? { content: 'const loaded = true;' }
              : { entries: [{ name: path === '.' ? 'src' : 'file.ts', dir: path === '.' }] },
        };
      }),
    );

    openCodeBrowser();
    await openFile('src/file.ts');
    await vi.waitFor(() => expect(store.state.workspace.codeBrowser.dirs['.']).toBeDefined());

    expect(store.state.workspace.codeBrowser.dirs.src).toBeDefined();
    expect(store.state.workspace.codeBrowser.fileLines).toEqual(['const loaded = true;']);
  });

  it('parses sandbox file links and their line numbers', () => {
    expect(workFileTarget('/work/src/pages/%5Blang%5D/index.astro:93')).toEqual({
      path: 'src/pages/[lang]/index.astro',
      line: 93,
    });
    expect(workFileTarget('https://example.com/file.ts')).toBeNull();
    expect(workFileTarget('/work/%ZZ')).toBeNull();
  });

  it('drags a multi-line range (and supports dragging upwards)', () => {
    beginLineSelect(5, false);
    expect(sel()).toEqual([5, 5]);
    dragLineSelect(9);
    expect(sel()).toEqual([5, 9]);
    dragLineSelect(2); // reverse past the anchor
    expect(sel()).toEqual([2, 5]);
    endLineSelect();
    dragLineSelect(20); // no longer dragging
    expect(sel()).toEqual([2, 5]);
  });

  it('shift-press extends from the existing anchor', () => {
    beginLineSelect(3, false);
    endLineSelect();
    beginLineSelect(10, true);
    expect(sel()).toEqual([3, 10]);
    endLineSelect();
  });

  it('pressing the single selected line again deselects', () => {
    beginLineSelect(4, false);
    endLineSelect();
    beginLineSelect(4, false);
    expect(sel()).toEqual([0, 0]);
  });
});
