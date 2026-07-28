/**
 * Workspace URL routing: /chat/<id>[?window=<kind>] parse/format, boot
 * normalization via replaceState, push-per-change, and popstate application
 * through the window state machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@/components/chat/app/store';
import { createInitialWorkspaceState } from '@/components/workspace/state';
import { openWindow, registerWindow } from '@/components/workspace/window';
import {
  applyRoute,
  initWorkspaceRouter,
  resetWorkspaceRouterForTests,
  routeFromLocation,
  urlForState,
} from '@/components/workspace/router';

registerWindow({
  kind: 'git',
  icon: '',
  tooltipKey: 'workspace.git.button',
  railAction: 'ws-git-open',
  order: 30,
  render: () => '',
});

/** location/history doubles that stay in sync like the real pair. */
const loc = { pathname: '/', search: '' };
const nav = (url: string) => {
  const u = new URL(url, 'http://localhost');
  loc.pathname = u.pathname;
  loc.search = u.search;
};
const pushes: string[] = [];
const replaces: string[] = [];

beforeEach(() => {
  store.state.workspace = createInitialWorkspaceState();
  store.state.activeChatId = null;
  store.state.branches = [];
  resetWorkspaceRouterForTests();
  loc.pathname = '/';
  loc.search = '';
  pushes.length = 0;
  replaces.length = 0;
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', {
    pushState: (_s: unknown, _t: string, url: string) => {
      pushes.push(url);
      nav(url);
    },
    replaceState: (_s: unknown, _t: string, url: string) => {
      replaces.push(url);
      nav(url);
    },
  });
  vi.stubGlobal('window', { addEventListener: () => {} });
});

afterEach(() => vi.unstubAllGlobals());

describe('route parsing and formatting', () => {
  it('parses chat id and known window kind', () => {
    expect(routeFromLocation({ pathname: '/chat/abc-123', search: '?window=git' })).toEqual({
      chatId: 'abc-123',
      window: 'git',
    });
  });

  it('drops unknown window kinds and non-chat paths', () => {
    expect(routeFromLocation({ pathname: '/chat/abc', search: '?window=nope' })).toEqual({
      chatId: 'abc',
      window: null,
    });
    expect(routeFromLocation({ pathname: '/', search: '' })).toEqual({ chatId: null, window: null });
    expect(routeFromLocation({ pathname: '/chat/a/b', search: '' }).chatId).toBeNull();
  });

  it('formats the canonical URL from state', () => {
    expect(urlForState(store.state)).toBe('/');
    store.state.activeChatId = 'c1';
    expect(urlForState(store.state)).toBe('/chat/c1');
    store.state.workspace.window = 'git';
    expect(urlForState(store.state)).toBe('/chat/c1?window=git');
  });
});

describe('history mirroring', () => {
  it('replaces on the first sync, pushes on later changes', () => {
    store.state.activeChatId = 'c1';
    initWorkspaceRouter();
    expect(replaces).toEqual(['/chat/c1']);
    expect(pushes).toEqual([]);

    openWindow('git');
    expect(pushes).toEqual(['/chat/c1?window=git']);

    store.notify(); // unrelated rerender — URL unchanged, nothing pushed
    expect(pushes).toEqual(['/chat/c1?window=git']);
  });

  it('applyRoute drives the window machine without echoing into history', () => {
    store.state.activeChatId = 'c1';
    initWorkspaceRouter();
    openWindow('git');
    const pushed = pushes.length;

    applyRoute({ chatId: 'c1', window: null }); // back-button shape
    expect(store.state.workspace.window).toBeNull();
    expect(pushes.length).toBe(pushed); // no new entry

    applyRoute({ chatId: 'unknown-chat', window: 'git' }); // stale deep link
    expect(store.state.activeChatId).toBe('c1'); // unknown id ignored
    expect(store.state.workspace.window).toBe('git');
  });
});
