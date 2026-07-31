/**
 * The navigation bar (route input + reload) is one component in two windows.
 *
 * Its markup is what events.ts dispatches on: the handlers find the scope on
 * the element, not in the action name, so a renderer that stops emitting
 * data-scope would silently navigate the wrong window. These assertions are
 * the contract between the two files.
 */
import { describe, expect, it } from 'vitest';
import { renderNavigation, shotReloadUrl } from '@/components/workspace/navigation';
import { renderPreviewToolbar } from '@/components/workspace/preview';
import { renderDiffViewer } from '@/components/workspace/diffViewer';
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
    attachmentsOnePerMessage: false,
    communicationMode: 'default',
    defaultCommunicationMode: 'non-technical',
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
    workflowPhase: 'execute',
    chat: null,
    workspace: ws,
  } as unknown as AppState;
};

describe('renderNavigation', () => {
  it('carries the scope on both controls', () => {
    const html = renderNavigation('diff', '/blog/');
    expect(html).toContain('data-nav="diff"');
    expect(html).toMatch(/data-action="ws-nav-go"[^>]*data-scope="diff"/);
    expect(html).toMatch(/data-action="ws-nav-reload"[^>]*data-scope="diff"/);
    expect(html).toContain('value="/blog/"');
  });

  it('escapes the route it echoes back', () => {
    expect(renderNavigation('preview', '/"><script>x</script>')).not.toContain('<script>');
  });

  // Reload re-requests the page; restart bounces the dev server serving it.
  // Both need the scope, because both act on whichever window they sit in.
  it('offers the server restart next to the page reload, in both windows', () => {
    for (const scope of ['preview', 'diff'] as const) {
      const html = renderNavigation(scope, '/');
      expect(html).toMatch(
        new RegExp(`data-action="ws-nav-restart"[^>]*data-scope="${scope}"`),
      );
    }
  });
});

describe('the windows that use it', () => {
  it('is the preview chrome bar\'s address bar', () => {
    const html = renderPreviewToolbar(mkState());
    expect(html).toContain('data-nav="preview"');
    expect(html).toContain('data-action="ws-nav-reload"');
    // The old per-window action names are gone — one handler serves both.
    expect(html).not.toContain('ws-address-form');
  });

  it('is the compare window\'s address bar', () => {
    const html = renderDiffViewer(mkState());
    expect(html).toContain('data-nav="diff"');
    expect(html).toContain('data-action="ws-nav-reload"');
    expect(html).not.toContain('ws-diff-address-form');
  });
});

describe('shotReloadUrl', () => {
  it('adds a nonce without dropping the query the endpoint needs', () => {
    const url = shotReloadUrl('/api/diff/chat-1/shot?route=%2Fblog%2F&kind=after', 3);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(url.startsWith('/api/diff/chat-1/shot?')).toBe(true);
    expect(params.get('route')).toBe('/blog/');
    expect(params.get('kind')).toBe('after');
    expect(params.get('_r')).toBe('3');
  });

  it('replaces its own nonce instead of stacking them', () => {
    const once = shotReloadUrl('/api/diff/c/shot?kind=before', 1);
    const twice = shotReloadUrl(once, 2);
    expect([...new URLSearchParams(twice.split('?')[1]).getAll('_r')]).toEqual(['2']);
  });
});
