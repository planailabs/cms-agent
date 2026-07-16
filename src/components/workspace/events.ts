/**
 * Workspace Events — delegated click handlers for phase/branch/diff actions,
 * the preview-overlay postMessage protocol (workspace side), sidebar
 * resizing, and the onion-skin slider.
 */

import { store } from '../chat/app/store';
import { delegateEvent } from '../chat/utils/dom';
import { switchChat } from '../chat/actions/chat';
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
  attachContextChip,
  removeContextChip,
  chipToNewChat,
  chipToCurrentChat,
} from './actions';
import type { DiffViewMode, PageContextElement, PageContextSelection } from './state';

const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 720;

const getPreviewIframe = (): HTMLIFrameElement | null =>
  document.getElementById('preview-iframe') as HTMLIFrameElement | null;

// ─────────────────────────────────────────────────────────────────────────────
// Overlay protocol (messages from the preview iframe)
// ─────────────────────────────────────────────────────────────────────────────

interface OverlayMessage {
  type?: string;
  url?: string;
  route?: string;
  anchor?: PageContextSelection;
  element?: PageContextElement;
}

const registerOverlayProtocol = (): void => {
  window.addEventListener('message', (event: MessageEvent) => {
    // Accept messages ONLY from the preview iframe
    const iframe = getPreviewIframe();
    if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;

    const data = event.data as OverlayMessage | null;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'cms:navigation': {
        if (typeof data.url === 'string') {
          onPreviewNavigation(data.url, typeof data.route === 'string' ? data.route : '/');
        }
        break;
      }
      case 'cms:selection': {
        if (data.anchor && typeof data.anchor.exact === 'string' && typeof data.url === 'string') {
          attachContextChip({
            kind: 'selection',
            context: { url: data.url, route: data.route, selection: data.anchor },
          });
        }
        break;
      }
      case 'cms:element': {
        if (data.element && typeof data.element.tag === 'string' && typeof data.url === 'string') {
          attachContextChip({
            kind: 'element',
            context: { url: data.url, route: data.route, element: data.element },
          });
        }
        break;
      }
      case 'cms:pick-cancel': {
        // Overlay exited pick mode (Esc) — un-arm the toolbar button
        if (store.state.workspace.pickerActive) {
          store.state.workspace.pickerActive = false;
          store.notify();
        }
        break;
      }
    }
  });
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
    const handle = (event.target as HTMLElement | null)?.closest('[data-action="ws-onion-handle"]');
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
    store.state.workspace.diff.onionPercent = pct; // silent
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

  // Element picker (posts into the preview iframe)
  delegateEvent(app, 'click', '[data-action="ws-element-pick"]', () => {
    const iframe = getPreviewIframe();
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'cms:start-element-pick' }, '*');
    store.state.workspace.pickerActive = true;
    store.notify();
  });

  // Context chip
  delegateEvent(app, 'click', '[data-action="ws-chip-remove"]', () => removeContextChip());
  delegateEvent(app, 'click', '[data-action="ws-chip-current"]', () => chipToCurrentChat());
  delegateEvent(app, 'click', '[data-action="ws-chip-new-chat"]', () => void chipToNewChat());

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

  registerOverlayProtocol();
  registerSidebarResize(app);
  registerOnionSlider(app);
  registerShotLoadStates();
};
