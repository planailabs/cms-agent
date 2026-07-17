/**
 * Workspace Events — delegated click handlers for phase/branch/diff actions,
 * the injected-agent event handlers (workspace side), sidebar resizing, and
 * the onion-skin slider.
 */

import { store } from '../chat/app/store';
import { delegateEvent } from '../chat/utils/dom';
import { switchChat } from '../chat/actions/chat';
import { continueChatSession } from '../chat/actions/chat/session';
import { registerDiffScrollSync } from './diffScroll';
import {
  approvePlanAction,
  requestChangesAction,
  createPreviewAction,
  dismissFinishExecution,
  undoExecutionAction,
  publishAction,
  newBranchAction,
  newChatAction,
  loadDiffPages,
  onPreviewNavigation,
  navigatePreviewTo,
  switchPreviewTab,
  closePreviewTab,
  newPreviewTab,
  attachContextChip,
  removeContextChip,
  openBrowserCompare,
  closeBrowserCompare,
  toggleBrowserCompareOverlay,
  setBrowserCompareMode,
  setBrowserCompareBrowser,
} from './actions';
import {
  registerPreviewAgent,
  onPreviewAgentEvent,
  startElementPick,
  cancelElementPick,
} from './previewAgent';
import type { DiffViewMode, PageContextElement, PageContextSelection } from './state';

const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 720;

// ─────────────────────────────────────────────────────────────────────────────
// Injected-agent events (messages from the module inside the preview iframe)
// ─────────────────────────────────────────────────────────────────────────────

const registerAgentEvents = (): void => {
  onPreviewAgentEvent('cms:navigation', (data) => {
    if (typeof data.url === 'string') {
      onPreviewNavigation(data.url, typeof data.route === 'string' ? data.route : '/');
    }
  });

  onPreviewAgentEvent('cms:selection', (data) => {
    const anchor = data.anchor as PageContextSelection | undefined;
    const { url, route } = data as { url?: string; route?: string };
    if (anchor && typeof anchor.exact === 'string' && typeof url === 'string') {
      attachContextChip({ kind: 'selection', context: { url, route, selection: anchor } });
    }
  });

  onPreviewAgentEvent('cms:element', (data) => {
    const element = data.element as PageContextElement | undefined;
    const { url, route } = data as { url?: string; route?: string };
    if (element && typeof element.tag === 'string' && typeof url === 'string') {
      attachContextChip({ kind: 'element', context: { url, route, element } });
    }
  });

  onPreviewAgentEvent('cms:pick-cancel', () => {
    // Module exited pick mode (Esc / cancel) — un-arm the toolbar button
    if (store.state.workspace.pickerActive) {
      store.state.workspace.pickerActive = false;
      store.notify();
    }
  });

  registerPreviewAgent();
};

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar resize (drag handle) — direct DOM updates while dragging,
// state committed on release (avoids re-render churn / iframe reloads).
// ─────────────────────────────────────────────────────────────────────────────

const registerSidebarResize = (app: HTMLElement): void => {
  let dragging = false;

  app.addEventListener('pointerdown', (event) => {
    const target = (event.target as HTMLElement | null)?.closest('#sidebar-resize-handle');
    if (!target) return;
    event.preventDefault();
    dragging = true;
    document.body.classList.add('ws-resizing');
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const sidebar = document.getElementById('sidebar-region');
    if (!sidebar) return;
    const width = Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - event.clientX),
    );
    sidebar.style.width = `${width}px`;
    store.state.workspace.sidebarWidth = width; // silent — style already applied
  });

  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ws-resizing');
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Onion-skin slider — direct DOM manipulation while dragging.
// ─────────────────────────────────────────────────────────────────────────────

const registerOnionSlider = (app: HTMLElement): void => {
  let dragging = false;

  app.addEventListener('pointerdown', (event) => {
    const handle = (event.target as HTMLElement | null)?.closest(
      '[data-action="ws-onion-handle"], [data-action="ws-bc-onion-handle"]',
    );
    if (!handle) return;
    event.preventDefault();
    dragging = true;
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const container = document.querySelector<HTMLElement>('[data-onion]');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));

    const after = container.querySelector<HTMLElement>('.ws-onion__after');
    const slider = container.querySelector<HTMLElement>('.ws-onion__slider');
    if (after) after.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    if (slider) slider.style.left = `${pct}%`;
    // Route to the right state slice (silent — DOM already updated)
    if (container.dataset.onionTarget === 'browserCompare') {
      store.state.workspace.browserCompare.onionPercent = pct;
    } else {
      store.state.workspace.diff.onionPercent = pct;
    }
  });

  window.addEventListener('pointerup', () => {
    dragging = false;
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot loading states (img load/error don't bubble → capture phase)
// ─────────────────────────────────────────────────────────────────────────────

const registerShotLoadStates = (): void => {
  document.addEventListener(
    'load',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'IMG' && target.hasAttribute('data-shot')) {
        target.closest('.ws-shot')?.classList.add('is-loaded');
      }
    },
    true,
  );
  document.addEventListener(
    'error',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'IMG' && target.hasAttribute('data-shot')) {
        target.closest('.ws-shot')?.classList.add('is-failed');
      }
    },
    true,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export const registerWorkspaceEvents = (app: HTMLElement): void => {
  // Phase / workflow card actions
  delegateEvent(app, 'click', '[data-action="ws-approve-plan"]', () => void approvePlanAction());
  delegateEvent(app, 'click', '[data-action="ws-request-changes"]', () => void requestChangesAction());
  delegateEvent(app, 'click', '[data-action="ws-create-preview"]', () => void createPreviewAction());
  delegateEvent(app, 'click', '[data-action="ws-dismiss-finish"]', () => dismissFinishExecution());
  delegateEvent(app, 'click', '[data-action="ws-undo-execution"]', (_e, target) => {
    const sha = target.getAttribute('data-sha');
    if (sha) void undoExecutionAction(sha);
  });
  delegateEvent(app, 'click', '[data-action="ws-publish"]', () => void publishAction());
  delegateEvent(app, 'click', '[data-action="ws-retry-publish"]', () =>
    void publishAction(store.state.workspace.publish?.sha),
  );

  // Branch switcher / chat list
  delegateEvent(app, 'click', '[data-action="ws-branch-list-toggle"]', () => {
    store.state.workspace.branchListOpen = !store.state.workspace.branchListOpen;
    store.notify();
  });
  delegateEvent(app, 'click', '[data-action="ws-new-branch"]', () => void newBranchAction());
  delegateEvent(app, 'click', '[data-action="ws-new-chat"]', (_e, target) => {
    const branchId = target.getAttribute('data-branch-id');
    if (branchId) void newChatAction(branchId);
  });
  delegateEvent(app, 'click', '[data-action="ws-open-chat"]', (_e, target) => {
    const chatId = target.getAttribute('data-chat-id');
    if (chatId) {
      store.state.workspace.branchListOpen = false;
      switchChat(chatId);
    }
  });

  // Sidebar collapse/expand
  delegateEvent(app, 'click', '[data-action="ws-sidebar-toggle"]', () => {
    store.state.workspace.sidebarCollapsed = !store.state.workspace.sidebarCollapsed;
    store.notify();
  });

  // Preview tabs + address bar
  delegateEvent(app, 'submit', '[data-action="ws-address-form"]', (event, target) => {
    event.preventDefault();
    const input = target.querySelector<HTMLInputElement>('.ws-address__input');
    if (input?.value) navigatePreviewTo(input.value);
  });
  delegateEvent(app, 'click', '[data-action="ws-tab-switch"]', (event, target) => {
    // The close × sits inside the tab button — let its own handler run alone
    if ((event.target as HTMLElement | null)?.closest('[data-action="ws-tab-close"]')) return;
    switchPreviewTab(Number(target.getAttribute('data-index')));
  });
  delegateEvent(app, 'click', '[data-action="ws-tab-close"]', (_e, target) => {
    closePreviewTab(Number(target.getAttribute('data-index')));
  });
  delegateEvent(app, 'click', '[data-action="ws-tab-new"]', () => newPreviewTab());

  // Element picker (toggles pick mode in the preview via the injected agent)
  delegateEvent(app, 'click', '[data-action="ws-element-pick"]', () => {
    const ws = store.state.workspace;
    if (ws.pickerActive) {
      cancelElementPick(); // module replies cms:pick-cancel, but un-arm now
      ws.pickerActive = false;
    } else {
      startElementPick();
      ws.pickerActive = true;
    }
    store.notify();
  });

  // Retry a failed turn / continue an interrupted session
  delegateEvent(app, 'click', '[data-action="chat-continue"]', () => void continueChatSession());

  // Context chip
  delegateEvent(app, 'click', '[data-action="ws-chip-remove"]', () => removeContextChip());

  // Diff viewer
  delegateEvent(app, 'click', '[data-action="ws-diff-reload"]', () => void loadDiffPages());
  delegateEvent(app, 'click', '[data-action="ws-diff-select-route"]', (_e, target) => {
    const route = target.getAttribute('data-route');
    if (route) {
      store.state.workspace.diff.selectedRoute = route;
      store.notify();
    }
  });
  delegateEvent(app, 'click', '[data-action="ws-diff-mode"]', (_e, target) => {
    const mode = target.getAttribute('data-mode') as DiffViewMode | null;
    if (mode) {
      store.state.workspace.diff.mode = mode;
      store.notify();
    }
  });
  delegateEvent(app, 'click', '[data-action="ws-diff-overlay-toggle"]', () => {
    store.state.workspace.diff.overlayVisible = !store.state.workspace.diff.overlayVisible;
    store.notify();
  });

  // Cross-browser comparison overlay
  delegateEvent(app, 'click', '[data-action="ws-bc-open"]', () => openBrowserCompare());
  delegateEvent(app, 'click', '[data-action="ws-bc-close"]', () => closeBrowserCompare());
  delegateEvent(app, 'click', '[data-action="ws-bc-overlay-toggle"]', () => toggleBrowserCompareOverlay());
  delegateEvent(app, 'click', '[data-action="ws-bc-mode"]', (_e, target) => {
    const mode = target.getAttribute('data-mode');
    if (mode === 'highlight' || mode === 'onion') setBrowserCompareMode(mode);
  });
  delegateEvent<Event>(app, 'change', '[data-action="ws-bc-browser"]', (_e, target) => {
    const which = target.getAttribute('data-which');
    const value = (target as HTMLSelectElement).value;
    if ((which === 'a' || which === 'b') && (value === 'chromium' || value === 'firefox' || value === 'webkit')) {
      setBrowserCompareBrowser(which, value);
    }
  });

  registerAgentEvents();
  registerSidebarResize(app);
  registerOnionSlider(app);
  registerShotLoadStates();
  registerDiffScrollSync();
};
