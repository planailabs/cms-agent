import './style.css';
import { locales } from './content/index';
import { renderHeader } from './ui/header';
import { renderSettingsOverlay } from './ui/settingsOverlay';
import { renderChatSection } from './ui/chat';
import { store } from './app/store';
import { streamingController } from './chat/streaming';

// Actions
import { ensureActiveChat } from './actions/chat';
import { loadProfile } from './actions/profile';
import { initTheme } from './actions/theme';

import { registerAllEvents } from './events';

const initApp = () => {
  const app = document.querySelector<HTMLDivElement>('#app');

  // Initialization of layout structure
  if (app) {
    app.innerHTML = `
    <div class="app-shell flex flex-col bg-(--surface-base) text-(--text-primary)">
      <div id="header-region" class="shrink-0"></div>

      <main id="main-region" class="flex min-h-0 flex-1 flex-col items-center px-6"></main>
    </div>
    <div id="overlay-region"></div>
  `;
  }

  const headerRegion = app?.querySelector('#header-region') as HTMLElement;
  const mainRegion = app?.querySelector('#main-region') as HTMLElement;
  const overlayRegion = app?.querySelector('#overlay-region') as HTMLElement;

  // Subscriptions
  store.subscribe(render);

  function render() {
    if (!app) {
      return;
    }
    const state = store.state;
    const locale = locales[state.localeKey];

    // 1. Update Header
    if (headerRegion) {
      headerRegion.innerHTML = renderHeader({ locale, state });
    }

    // 2. Update Main Region (chat — the app starts directly in chat)
    if (mainRegion) {
      const isChatEmpty = (state.chat?.aiChat?.messages.length ?? 0) === 0;
      // Empty chat: use justify-center to vertically center content
      // Chat with messages: use pt-10 and start from top with scrollable content
      const mainClasses = isChatEmpty
        ? 'flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-6'
        : 'flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-10 pb-6';

      if (mainRegion.className !== mainClasses) {
        mainRegion.className = mainClasses;
      }

      mainRegion.innerHTML = renderChatSection(locale, state);
      // Auto-scroll to bottom during streaming, waiting, or just after
      const mc = state.chat?.aiChat;
      if (mc?.phase === 'streaming' || mc?.phase === 'waiting'
        || mc?.phase === 'idle' || mc?.phase === 'question') {
        mainRegion.scrollTop = mainRegion.scrollHeight;
      }
    }

    // 3. Update Overlay
    if (overlayRegion) {
      const overlayMarkup = renderSettingsOverlay({ state, locale });
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
  }

  // Initialization — the user is always signed in (server-side auth),
  // so load the profile and open the active chat straight away.
  initTheme();
  void loadProfile();
  void ensureActiveChat();

  store.notify(); // Initial render via subscription (since render is subscribed)
  // We can also explicitly call render() if store.subscribe doesn't fire on init
  // But subscribe only fires on changes. So we do need an initial render.
  render();

  // Trigger fade-in effect (on load/refresh)
  // This runs after the initial render is complete
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
