/**
 * Workspace Events — delegated click handlers for phase/branch/diff actions,
 * the injected-agent event handlers (workspace side), sidebar resizing, and
 * the onion-skin slider.
 */

import { store } from '../chat/app/store';
import { t, uiLocale } from '@/lib/i18n';
import { delegateEvent } from '../chat/utils/dom';
import { switchChat } from '../chat/actions/chat';
import { continueChatSession } from '../chat/actions/chat/session';
import { registerDiffScrollSync } from './diffScroll';
import { navigateDiffTo } from './diffViewer';
import { openInputModal, closeInputModal, submitInputModal } from './modal';
import { closeWindow } from './window';
import {
  approvePlanAction,
  requestChangesAction,
  createPreviewAction,
  dismissFinishExecution,
  undoExecutionAction,
  publishAction,
  resumeAutomatismAction,
  syncAction,
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
  adoptDiffRoute,
  startEditMode,
  stopEditMode,
  setEditTool,
  onEditChanged,
  handoffEditAction,
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
  postEditUndo,
  postEditClear,
} from './previewAgent';
import { openArchive, closeArchive, deleteArchivedChat, openArchivedChat } from './archive';
import { openGitModal, closeGitModal, loadGitCommits, selectGitCommit, backToGitList } from './gitModal';
import { openCapsModal, closeCapsModal, loadCapabilities } from './capsModal';
import { openPlanModal, closePlanModal } from './planModal';
import {
  adoptWindowSession,
  closeWindowPicker,
  deleteWindowSession,
  openWindowPicker,
  startFreshWindow,
} from './windowSession';
import {
  addCodeContext,
  beginLineSelect,
  closeCodeBrowser,
  copyOpenFile,
  dragLineSelect,
  endLineSelect,
  openCodeBrowser,
  openFile,
  toggleDir,
  workFileTarget,
} from './codeBrowser';
import type { EditAnnotations, EditTool } from '@/injected/annotate';
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

  onPreviewAgentEvent('cms:edit-changed', (data) => {
    const annotations = data.annotations as EditAnnotations | undefined;
    if (annotations && Array.isArray(annotations.moves)) onEditChanged(annotations);
  });

  onPreviewAgentEvent('cms:edit-stopped', () => {
    // Esc inside the page — the module already tore its overlay down
    stopEditMode({ notifyIframe: false });
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
  let container: HTMLElement | null = null; // the .ws-onion being dragged
  let isBc = false; // browser-compare vs diff viewer

  app.addEventListener('pointerdown', (event) => {
    const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-action="ws-onion-handle"], [data-action="ws-bc-onion-handle"]',
    );
    if (!handle) return;
    event.preventDefault();
    container = handle.closest<HTMLElement>('.ws-onion');
    isBc = handle.getAttribute('data-action') === 'ws-bc-onion-handle';
  });

  window.addEventListener('pointermove', (event) => {
    if (!container) return;
    // Measure the canvas, not the scroll container — the slider's left% is
    // relative to the canvas, which excludes the scrollbar width.
    const canvas = container.querySelector<HTMLElement>('.ws-onion__canvas') ?? container;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));

    const after = container.querySelector<HTMLElement>('.ws-onion__after');
    const slider = container.querySelector<HTMLElement>('.ws-onion__slider');
    // top layer shows RIGHT of the slider (before left / after right)
    if (after) after.style.clipPath = `inset(0 0 0 ${pct}%)`;
    if (slider) slider.style.left = `${pct}%`;
    // Route to the right state slice (silent — DOM already updated)
    if (isBc) store.state.workspace.browserCompare.onionPercent = pct;
    else store.state.workspace.diff.onionPercent = pct;
  });

  window.addEventListener('pointerup', () => {
    container = null;
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
  delegateEvent<MouseEvent>(app, 'click', '[data-action="chat-code-link"]', (event, link) => {
    const target = workFileTarget(link.getAttribute('href') ?? '');
    if (!target) return;
    event.preventDefault();
    openCodeBrowser();
    void openFile(target.path, target.line);
  });

  // Route-chip dropdown (diff viewer) closes on outside clicks.
  document.addEventListener('click', (event) => {
    const diff = store.state.workspace.diff;
    if (!diff.routesOpen) return;
    const menu = document.querySelector('[data-menu="diff-routes"]');
    if (menu && !menu.contains(event.target as Node)) {
      diff.routesOpen = false;
      store.notify();
    }
  });

  // ESC closes whichever workspace modal is open (topmost first). The settings
  // overlay has its own Esc handler (chat/actions/overlay.ts).
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const ws = store.state.workspace;
    const closers: Array<[boolean, () => void]> = [
      [ws.inputModal !== null, closeInputModal],
      [ws.diff.routesOpen, () => { ws.diff.routesOpen = false; store.notify(); }],
      [ws.window !== null, closeWindow],
      [ws.planModalOpen, closePlanModal],
      [ws.windowPicker !== null, closeWindowPicker],
      [ws.elementEdit.active, () => stopEditMode()],
    ];
    const hit = closers.find(([open]) => open);
    if (hit) {
      event.preventDefault();
      hit[1]();
    }
  });

  // Phase / workflow card actions
  delegateEvent(app, 'click', '[data-action="ws-approve-plan"]', () => void approvePlanAction());
  delegateEvent(app, 'click', '[data-action="ws-request-changes"]', () =>
    openInputModal(
      {
        title: t(uiLocale(), 'workspace.phase.requestChanges'),
        hint: t(uiLocale(), 'workspace.requestChanges.hint'),
        placeholder: t(uiLocale(), 'workspace.requestChanges.placeholder'),
      },
      (text) => void requestChangesAction(text),
    ),
  );

  // Generic input modal (composer-style input)
  delegateEvent(app, 'click', '[data-action="ws-modal-close"]', () => closeInputModal());
  delegateEvent(app, 'click', '[data-action="ws-modal-send"]', () => submitInputModal());
  delegateEvent<Event>(app, 'input', '[data-action="ws-modal-input"]', (_e, target) => {
    const empty = !(target.textContent ?? '').trim();
    target.setAttribute('data-empty', String(empty));
    const send = document.querySelector<HTMLButtonElement>('[data-action="ws-modal-send"]');
    if (send) {
      const disabled = empty && !store.state.workspace.inputModal?.allowEmpty;
      send.disabled = disabled;
      send.setAttribute('aria-disabled', String(disabled));
    }
  });
  delegateEvent<KeyboardEvent>(app, 'keydown', '[data-action="ws-modal-input"]', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitInputModal();
    } else if (event.key === 'Escape') {
      closeInputModal();
    }
  });
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
  delegateEvent(app, 'click', '[data-action="ws-automatism-resume"]', () =>
    void resumeAutomatismAction(),
  );
  delegateEvent(app, 'click', '[data-action="ws-sync"]', () => void syncAction());

  // Branch switcher / chat list
  delegateEvent(app, 'click', '[data-action="ws-branch-list-toggle"]', () => {
    store.state.workspace.branchListOpen = !store.state.workspace.branchListOpen;
    store.notify();
  });
  delegateEvent(app, 'click', '[data-action="ws-new-branch"]', () =>
    openInputModal(
      {
        title: t(uiLocale(), 'workspace.newBranch.title'),
        hint: t(uiLocale(), 'workspace.newBranch.hint'),
        placeholder: t(uiLocale(), 'workspace.newBranch.placeholder'),
      },
      (name) => void newBranchAction(name),
    ),
  );
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

  // Archive modal (done chats)
  delegateEvent(app, 'click', '[data-action="ws-archive-open"]', () => void openArchive());
  delegateEvent(app, 'click', '[data-action="ws-archive-close"]', () => closeArchive());
  delegateEvent(app, 'click', '[data-action="ws-archive-delete"]', (_e, target) => {
    const chatId = target.getAttribute('data-chat-id');
    if (chatId) void deleteArchivedChat(chatId);
  });
  delegateEvent(app, 'click', '[data-action="ws-archive-view"]', (_e, target) => {
    const chatId = target.getAttribute('data-chat-id');
    if (chatId) openArchivedChat(chatId);
  });

  // Git modal (commit list + diffs)
  delegateEvent(app, 'click', '[data-action="ws-git-open"]', () => openGitModal());
  delegateEvent(app, 'click', '[data-action="ws-git-close"]', () => closeGitModal());
  delegateEvent(app, 'click', '[data-action="ws-git-back"]', () => backToGitList());
  delegateEvent(app, 'click', '[data-action="ws-git-commit"]', (_e, target) => {
    const sha = target.getAttribute('data-sha');
    if (sha) void selectGitCommit(sha);
  });
  delegateEvent<Event>(app, 'change', '[data-action="ws-git-branch"]', (_e, target) => {
    void loadGitCommits((target as HTMLSelectElement).value || null);
  });

  // Capabilities modal (skills + MCP status)
  delegateEvent(app, 'click', '[data-action="ws-caps-open"]', () => openCapsModal());
  delegateEvent(app, 'click', '[data-action="ws-plan-open"]', () => openPlanModal());
  delegateEvent(app, 'click', '[data-action="ws-plan-close"]', () => closePlanModal());
  delegateEvent(app, 'click', '[data-action="ws-cb-modal-open"]', () => openCodeBrowser());
  delegateEvent(app, 'click', '[data-action="ws-cb-modal-close"]', () => closeCodeBrowser());
  delegateEvent(app, 'click', '[data-action="ws-cb-dir"]', (_e, target) =>
    toggleDir(target.dataset.path ?? '.'),
  );
  delegateEvent(app, 'click', '[data-action="ws-cb-file"]', (_e, target) => {
    if (target.dataset.path) void openFile(target.dataset.path);
  });
  delegateEvent<PointerEvent>(app, 'pointerdown', '[data-action="ws-cb-line"]', (event, target) => {
    if (event.button !== 0) return;
    event.preventDefault(); // native text selection would fight the drag
    const line = Number(target.dataset.line);
    if (line > 0) beginLineSelect(line, event.shiftKey);
  });
  delegateEvent(app, 'pointerover', '[data-action="ws-cb-line"]', (_event, target) => {
    const line = Number(target.dataset.line);
    if (line > 0) dragLineSelect(line);
  });
  window.addEventListener('pointerup', () => endLineSelect());
  delegateEvent(app, 'click', '[data-action="ws-cb-add"]', () => addCodeContext());
  delegateEvent(app, 'click', '[data-action="ws-cb-copy"]', () => void copyOpenFile());
  delegateEvent(app, 'click', '[data-action="ws-wsn-restore"]', (_e, target) => {
    if (target.dataset.id) void adoptWindowSession(target.dataset.id);
  });
  delegateEvent(app, 'click', '[data-action="ws-wsn-delete"]', (_e, target) => {
    if (target.dataset.id) void deleteWindowSession(target.dataset.id);
  });
  delegateEvent(app, 'click', '[data-action="ws-wsn-fresh"]', () => startFreshWindow());
  delegateEvent(app, 'click', '[data-action="ws-wsn-open"]', () => void openWindowPicker());
  delegateEvent(app, 'click', '[data-action="ws-wsn-close"]', () => closeWindowPicker());
  delegateEvent(app, 'click', '[data-action="ws-compare-align"]', () => {
    const ws = store.state.workspace;
    ws.compareMode = ws.compareMode === 'content' ? 'height' : 'content';
    store.notify();
  });
  delegateEvent(app, 'click', '[data-action="ws-caps-close"]', () => closeCapsModal());
  delegateEvent<Event>(app, 'change', '[data-action="ws-caps-chat"]', (_e, target) => {
    void loadCapabilities((target as HTMLSelectElement).value || null);
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
      closeWindow(); // picking happens on the live preview — windows yield
      ws.pickerActive = true;
      // From the diff viewer the live preview mounts on notify — open it on
      // the reviewed page; the module push re-arms the pick there.
      adoptDiffRoute();
      startElementPick();
    }
    store.notify();
  });

  // Element-edit mode (annotate the preview → handoff to the agent)
  delegateEvent(app, 'click', '[data-action="ws-edit-mode"]', () => startEditMode());
  delegateEvent(app, 'click', '[data-action="ws-edit-exit"]', () => stopEditMode());
  delegateEvent(app, 'click', '[data-action="ws-edit-tool"]', (_e, target) => {
    const tool = target.getAttribute('data-tool') as EditTool | null;
    if (tool === 'cursor' || tool === 'move' || tool === 'swap' || tool === 'draw' || tool === 'comment') {
      setEditTool(tool);
    }
  });
  delegateEvent(app, 'click', '[data-action="ws-edit-undo"]', () => postEditUndo());
  delegateEvent(app, 'click', '[data-action="ws-edit-clear"]', () => postEditClear());
  delegateEvent(app, 'click', '[data-action="ws-edit-handoff"]', () =>
    openInputModal(
      {
        title: t(uiLocale(), 'workspace.handoff.title'),
        hint: t(uiLocale(), 'workspace.handoff.hint'),
        placeholder: t(uiLocale(), 'workspace.handoff.placeholder'),
        allowEmpty: true,
      },
      (note) => void handoffEditAction(note),
    ),
  );

  // Retry a failed turn / continue an interrupted session
  delegateEvent(app, 'click', '[data-action="chat-continue"]', () => void continueChatSession());

  // Context chip
  delegateEvent(app, 'click', '[data-action="ws-chip-remove"]', () => removeContextChip());

  // Diff viewer
  delegateEvent(app, 'click', '[data-action="ws-diff-reload"]', () => void loadDiffPages());
  delegateEvent(app, 'click', '[data-action="ws-diff-select-route"]', (_e, target) => {
    const route = target.getAttribute('data-route');
    const diff = store.state.workspace.diff;
    if (diff.routesOpen) {
      diff.routesOpen = false;
      store.notify(); // close even when the route doesn't change
    }
    if (route) navigateDiffTo(route);
  });
  delegateEvent(app, 'click', '[data-action="ws-diff-routes-toggle"]', () => {
    const diff = store.state.workspace.diff;
    diff.routesOpen = !diff.routesOpen;
    store.notify();
  });
  delegateEvent(app, 'submit', '[data-action="ws-diff-address-form"]', (event, target) => {
    event.preventDefault();
    const input = target.querySelector<HTMLInputElement>('.ws-address__input');
    if (input?.value) navigateDiffTo(input.value);
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
    if (mode === 'highlight' || mode === 'onion' || mode === 'scroll') setBrowserCompareMode(mode);
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
