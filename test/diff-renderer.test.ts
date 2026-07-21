import { describe, expect, it } from 'vitest';
import { renderDiffViewer } from '@/components/workspace/diffViewer';
import { renderBrowserCompare } from '@/components/workspace/browserCompare';
import { createInitialWorkspaceState } from '@/components/workspace/state';
import type { AppState } from '@/components/chat/app/state';

const mkState = (): AppState => {
  const ws = createInitialWorkspaceState();
  ws.diff.loaded = true;
  ws.diff.pages = [{ route: '/', file: 'src/pages/index.astro' }];
  ws.diff.selectedRoute = '/';
  return {
    localeKey: 'en',
    themeMode: 'dark',
    isLanguageMenuOpen: false,
    isAuthMenuOpen: false,
    isSettingsOverlayOpen: false,
    user: null,
    branches: [],
    activeBranchId: 'branch-1',
    activeChatId: 'chat-1',
    activeChatKind: 'workflow',
    activeChatTitle: 'Chat 1',
    activeChatArchived: false,
    workflowPhase: 'preview',
    chat: null,
    workspace: ws,
  };
};

describe('diff compare renderers', () => {
  it('renders raw diff shots for onion mode and marks the container for content alignment', () => {
    const state = mkState();
    state.workspace.compareMode = 'content';
    state.workspace.diff.mode = 'onion';

    const html = renderDiffViewer(state);
    expect(html).toContain('class="ws-onion" data-onion');
    expect(html).toContain('/api/diff/chat-1/shot?route=%2F&amp;kind=before');
    expect(html).toContain('/api/diff/chat-1/shot?route=%2F&amp;kind=after');
    expect(html).not.toContain('kind=before-aligned');
    expect(html).not.toContain('kind=after-aligned');
  });

  it('renders raw browser-compare shots for onion mode and keeps scroll aligned-shot based', () => {
    const state = mkState();
    state.workspace.compareMode = 'content';
    state.workspace.browserCompare.open = true;
    state.workspace.browserCompare.mode = 'onion';
    let html = renderBrowserCompare(state);
    expect(html).toContain('class="ws-onion" data-onion');
    expect(html).toContain('kind=before');
    expect(html).toContain('kind=after');
    expect(html).not.toContain('kind=before-aligned');
    expect(html).not.toContain('kind=after-aligned');

    state.workspace.browserCompare.mode = 'scroll';
    html = renderBrowserCompare(state);
    expect(html).toContain('kind=before-aligned');
    expect(html).toContain('kind=after-aligned');
  });

  it('keeps highlight mode on raw before/after shots for box overlays', () => {
    const state = mkState();
    state.workspace.compareMode = 'content';
    state.workspace.diff.mode = 'highlight';

    const html = renderDiffViewer(state);
    expect(html).toContain('data-boxhl');
    expect(html).toContain('data-before="/api/diff/chat-1/shot?route=%2F&amp;kind=before"');
    expect(html).toContain('data-after="/api/diff/chat-1/shot?route=%2F&amp;kind=after"');
  });
});
