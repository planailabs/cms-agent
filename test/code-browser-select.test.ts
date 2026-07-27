/**
 * Code-browser multi-line selection: drag ranges, shift-extend, reverse
 * drags, and single-line deselect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@/components/chat/app/store';
import { createInitialWorkspaceState } from '@/components/workspace/state';
import {
  beginLineSelect,
  copyOpenFile,
  dragLineSelect,
  endLineSelect,
  openCodeBrowser,
  openFile,
  renderCodeBrowser,
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

  it('previews images inline instead of fetching text', async () => {
    store.state.activeChatId = 'chat';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await openFile('public/logo.png', 7);

    const cb = store.state.workspace.codeBrowser;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cb.loading).toBe(false);
    expect([cb.selStart, cb.selEnd]).toEqual([0, 0]);
    const html = renderCodeBrowser(store.state);
    expect(html).toContain('ws-cb-image');
    expect(html).toContain('mode=raw');
    expect(html).not.toContain('ws-cb-copy'); // no text to copy
  });

  it('parses sandbox file links and their line numbers', () => {
    expect(workFileTarget('/work/src/pages/%5Blang%5D/index.astro:93')).toEqual({
      path: 'src/pages/[lang]/index.astro',
      line: 93,
    });
    expect(workFileTarget('https://example.com/file.ts')).toBeNull();
    expect(workFileTarget('/work/%ZZ')).toBeNull();
  });

  it('copies the full file from the raw endpoint', async () => {
    store.state.activeChatId = 'chat';
    store.state.workspace.codeBrowser.filePath = 'src/file.ts';
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('full file contents')));

    expect(await copyOpenFile()).toBe(true);
    expect(writeText).toHaveBeenCalledWith('full file contents');
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('mode=raw');
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
