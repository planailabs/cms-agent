import './style.css';
import { locales } from './content/index';
import { t, uiLocale } from '@/lib/i18n';
import { renderHeader } from './ui/header';
import { renderSettingsOverlay } from './ui/settingsOverlay';
import { renderChatSection } from './ui/chat';
import { store } from './app/store';
import { streamingController } from './chat/streaming';

// Actions
import { loadProfile } from './actions/profile';
import { initTheme } from './actions/theme';

import { registerAllEvents } from './events';

// Workspace (preview pane, diff viewer, phase bar, sidebar)
import { renderPreviewSkeleton, renderPreviewToolbar } from '../workspace/preview';
import { syncPreviewFrames } from '../workspace/previewFrames';
import { renderDiffViewer } from '../workspace/diffViewer';
import { renderBrowserCompare } from '../workspace/browserCompare';
import { renderBranchSwitcher, renderPhaseBar } from '../workspace/sidebar';
import { renderRail } from '../workspace/rail';
import { renderArchiveModal } from '../workspace/archive';
import { renderGitModal } from '../workspace/gitModal';
import { renderCapsModal } from '../workspace/capsModal';
import { renderPlanModal } from '../workspace/planModal';
import { syncBoxHighlights } from '../workspace/highlightAlign';
import { syncDiffContentAlignment } from '../workspace/diffScroll';
import { renderCodeBrowser } from '../workspace/codeBrowser';
import { bootWindowSession, renderWindowPicker } from '../workspace/windowSession';
import { startUpdateWatcher } from '../workspace/appUpdate';
import { renderInputModal } from '../workspace/modal';
import { registerWorkspaceEvents } from '../workspace/events';
import { loadDiffPages } from '../workspace/actions';

/**
 * Sets innerHTML only when the markup actually changed. Prevents iframe
 * reloads / image flicker on unrelated store notifications.
 */
const LAST_HTML = new WeakMap<HTMLElement, string>();
const setHtmlIfChanged = (el: HTMLElement, html: string): boolean => {
  if (LAST_HTML.get(el) === html) return false;
  LAST_HTML.set(el, html);
  el.innerHTML = html;
  return true;
};

const initApp = () => {
  const app = document.querySelector<HTMLDivElement>('#app');

  // Workspace layout: header on top, then main area (preview / diff viewer)
  // with the resizable chat sidebar on the right.
  if (app) {
    app.innerHTML = `
    <div class="app-shell flex flex-col bg-(--surface-base) text-(--text-primary)">
      <div id="header-region" class="shrink-0"></div>

      <div class="ws-layout flex min-h-0 flex-1">
        <nav id="rail-region" class="ws-rail" aria-label="Tools"></nav>
        <main id="main-region" class="ws-main min-w-0 flex-1"></main>
        <div id="sidebar-resize-handle" class="ws-resize-handle" role="separator"
          aria-orientation="vertical" aria-label="${t(uiLocale(), 'chat.sidebar.resize')}"></div>
        <aside id="sidebar-region" class="ws-sidebar"></aside>
      </div>
    </div>
    <div id="overlay-region"></div>
  `;
  }

  const headerRegion = app?.querySelector('#header-region') as HTMLElement;
  const railRegion = app?.querySelector('#rail-region') as HTMLElement;
  const mainRegion = app?.querySelector('#main-region') as HTMLElement;
  const sidebarRegion = app?.querySelector('#sidebar-region') as HTMLElement;
  const resizeHandle = app?.querySelector('#sidebar-resize-handle') as HTMLElement;
  const overlayRegion = app?.querySelector('#overlay-region') as HTMLElement;

  // Subscriptions
  store.subscribe(render);

  function render() {
    if (!app) {
      return;
    }
    const state = store.state;
    const locale = locales[state.localeKey];
    const ws = state.workspace;

    // 1. Update Header + icon rail
    if (headerRegion) {
      headerRegion.innerHTML = renderHeader({ locale, state });
    }
    if (railRegion) {
      setHtmlIfChanged(railRegion, renderRail(state));
    }

    // 2. Main area: diff viewer in the PREVIEW phase, live preview otherwise.
    if (mainRegion) {
      // Edit mode and the armed element picker force the live preview even
      // in the PREVIEW phase (the diff viewer returns when they end).
      const inPreviewPhase =
        state.workflowPhase === 'preview' &&
        !!state.activeChatId &&
        !ws.elementEdit.active &&
        !ws.pickerActive;
      if (inPreviewPhase && !ws.diff.loaded && !ws.diff.loading && !ws.diff.error) {
        void loadDiffPages(); // lazy-load the changed pages on entering PREVIEW
      }
      if (ws.browserCompare.open) {
        // Cross-browser comparison overlay — replaces the main area in both
        // the PREVIEW phase and regular preview mode.
        setHtmlIfChanged(mainRegion, renderBrowserCompare(state));
      } else if (inPreviewPhase) {
        setHtmlIfChanged(mainRegion, renderDiffViewer(state));
      } else {
        // Toolbar and iframe render into separate sub-regions: toolbar state
        // (picker armed, current route) must not recreate the iframe node —
        // that reloads the preview and kills the injected agent's pick mode.
        setHtmlIfChanged(mainRegion, renderPreviewSkeleton());
        const toolbarRegion = mainRegion.querySelector<HTMLElement>('#preview-toolbar-region');
        const frameRegion = mainRegion.querySelector<HTMLElement>('#preview-frame-region');
        if (toolbarRegion) setHtmlIfChanged(toolbarRegion, renderPreviewToolbar(state));
        // Imperative reconcile — per-tab iframes must never be re-created
        // by an innerHTML pass (that reloads every tab).
        if (frameRegion) syncPreviewFrames(frameRegion, state);
      }
      void syncDiffContentAlignment(state);
      syncBoxHighlights(state);
    }

    // 3. Right sidebar: branch switcher, phase bar, chat.
    if (sidebarRegion) {
      if (ws.sidebarCollapsed) {
        sidebarRegion.classList.add('is-collapsed');
        sidebarRegion.style.width = '';
        if (resizeHandle) resizeHandle.style.display = 'none';
        const expandLabel = t(uiLocale(), 'chat.sidebar.expand');
        setHtmlIfChanged(
          sidebarRegion,
          `<button type="button" class="ws-sidebar-expand" data-action="ws-sidebar-toggle"
            title="${expandLabel}" aria-label="${expandLabel}">💬</button>`,
        );
      } else {
        sidebarRegion.classList.remove('is-collapsed');
        sidebarRegion.style.width = `${ws.sidebarWidth}px`;
        if (resizeHandle) resizeHandle.style.display = '';

        const sidebarHtml = `
          <div class="ws-sidebar-top">
            <div class="ws-sidebar-top__row">
              ${renderBranchSwitcher(state)}
              <button type="button" class="ws-mini-button ws-sidebar-collapse" data-action="ws-sidebar-toggle"
                title="${t(uiLocale(), 'chat.sidebar.collapse')}" aria-label="${t(uiLocale(), 'chat.sidebar.collapse')}">⇥</button>
            </div>
            ${renderPhaseBar(state)}
          </div>
          <div id="chat-scroll-region" class="ws-chat-region">
            ${renderChatSection(locale, state)}
          </div>`;
        // innerHTML replacement resets scroll — preserve it across renders:
        // pinned-to-bottom viewers follow new content (every phase, tool use
        // included); scrolled-up viewers keep their reading position.
        const prevChat = sidebarRegion.querySelector<HTMLElement>('#chat-scroll-region');
        const prevTop = prevChat?.scrollTop ?? 0;
        const wasPinned =
          !prevChat ||
          prevChat.scrollHeight - prevChat.scrollTop - prevChat.clientHeight < 40;
        sidebarRegion.innerHTML = sidebarHtml;
        LAST_HTML.delete(sidebarRegion);

        const chatRegion = sidebarRegion.querySelector<HTMLElement>('#chat-scroll-region');
        if (chatRegion) {
          chatRegion.scrollTop = wasPinned ? chatRegion.scrollHeight : prevTop;
        }
      }
    }

    // 4. Update Overlay (settings + full-screen archive modal)
    if (overlayRegion) {
      const overlayMarkup =
        renderSettingsOverlay({ state, locale }) +
        renderArchiveModal(state) +
        renderGitModal(state) +
        renderCapsModal(state) +
        renderPlanModal(state) +
        renderCodeBrowser(state) +
        renderWindowPicker(state) +
        renderInputModal(state);
      if (overlayRegion.innerHTML !== overlayMarkup) {
        overlayRegion.innerHTML = overlayMarkup;
      }
    }

    // Reset animations after render
    streamingController.scheduleBubbleAnimationReset();
  }

  // --- Event Delegation Setup ---

  if (app) {
    registerAllEvents(app);
    registerWorkspaceEvents(app);
  }

  // Initialization — the user is always signed in (server-side auth),
  // so load the profile and open the active chat straight away.
  initTheme();
  void loadProfile();
  // Window-session boot: a fresh window sees the "continue where you left
  // off?" offer FIRST; the workspace loads only after the choice.
  void bootWindowSession();
  // Reload + restore this window when a newer build is deployed.
  startUpdateWatcher();

  store.notify(); // Initial render via subscription (since render is subscribed)
  render();

  // Trigger fade-in effect (on load/refresh)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('is-first-visit');
    });
  });
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
