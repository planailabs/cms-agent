/**
 * The compare (diff) view is a registered stage window, not a phase: the rail
 * eye button opens it, its flyout lists the view modes, and a second click
 * closes it.
 */
import { describe, expect, it } from 'vitest';
import '@/components/workspace/diffViewer'; // registers the window
import { registeredWindows, renderActiveWindow, toggleWindow } from '@/components/workspace/window';
import { renderRail } from '@/components/workspace/rail';
import { store } from '@/components/chat/app/store';

const compareDef = () => registeredWindows().find((w) => w.kind === 'compare')!;

describe('compare window', () => {
  it('registers ahead of the other stage windows with an eye rail button', () => {
    const def = compareDef();
    expect(def).toBeTruthy();
    expect(def.railAction).toBe('ws-compare-open');
    expect(def.railMenu).toBeTypeOf('function');
    // First stage window in the rail — reviewing is the primary tool.
    expect(registeredWindows()[0].kind).toBe('compare');
  });

  it('renders the diff viewer only while it is the active window', () => {
    const ws = store.state.workspace;
    ws.window = null;
    ws.diff.loaded = true;
    ws.diff.pages = [{ route: '/', file: 'src/pages/index.astro' }];
    ws.diff.selectedRoute = '/';
    store.state.activeChatId = 'chat-1';

    expect(renderActiveWindow(store.state)).toBeNull();
    toggleWindow('compare');
    expect(renderActiveWindow(store.state)).toContain('ws-diff');
    // Rail semantics: clicking the active window's icon closes it.
    toggleWindow('compare');
    expect(store.state.workspace.window).toBeNull();
    expect(renderActiveWindow(store.state)).toBeNull();
  });

  it('lists every view mode in the rail flyout and marks the current one', () => {
    const ws = store.state.workspace;
    ws.diff.mode = 'onion';
    ws.diff.menuOpen = true;
    store.state.activeChatId = 'chat-1';

    const rail = renderRail(store.state);
    expect(rail).toContain('ws-rail__item'); // hover/outside-click boundary
    expect(rail).toContain('ws-compare-menu is-open');
    for (const mode of ['side-by-side', 'scroll', 'highlight', 'onion']) {
      expect(rail).toContain(`data-mode="${mode}"`);
    }
    expect(rail).toContain('ws-compare-menu__item is-active');

    ws.diff.menuOpen = false;
    expect(renderRail(store.state)).not.toContain('is-open');
  });
});
