/**
 * Dashboard tab router — ported from chat/'s dashboard tabs.ts.
 *
 * URL-driven tabs (/dashboard/<tab>/) with history.pushState navigation and
 * lazy per-tab module initialization. Supabase-era tabs (messages, pings,
 * impersonate, customer tokens) are dropped; grants + memory are new.
 */

const TAB_NAMES = [
  'overview',
  'tokens',
  'users',
  'prompts',
  'grants',
  'memory',
] as const;
type TabName = (typeof TAB_NAMES)[number];

const initialized = new Set<TabName>();

function getTabFromPath(): TabName {
  const path = location.pathname.replace(/\/+$/, '');
  const segment = path.split('/').pop() ?? '';
  if (TAB_NAMES.includes(segment as TabName) && segment !== 'dashboard') {
    return segment as TabName;
  }
  return 'overview';
}

function activateTab(tab: TabName) {
  // Update tab buttons
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });

  // Show/hide panels
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tab}`);
  });

  // Lazy init
  if (!initialized.has(tab)) {
    initialized.add(tab);
    void initTabModule(tab);
  }
}

async function initTabModule(tab: TabName) {
  switch (tab) {
    case 'overview': {
      const { initOverview } = await import('./overview');
      void initOverview(document.getElementById('tab-overview')!);
      break;
    }
    case 'tokens': {
      const { initTokens } = await import('./tokens');
      void initTokens(document.getElementById('tab-tokens')!);
      break;
    }
    case 'users': {
      const { initUsers } = await import('./users');
      void initUsers(document.getElementById('tab-users')!);
      break;
    }
    case 'prompts': {
      const { initPrompts } = await import('./prompts');
      initPrompts(document.getElementById('tab-prompts')!);
      break;
    }
    case 'grants': {
      const { initGrants } = await import('./grants');
      void initGrants(document.getElementById('tab-grants')!);
      break;
    }
    case 'memory': {
      const { initMemory } = await import('./memory');
      void initMemory(document.getElementById('tab-memory')!);
      break;
    }
  }
}

export function initTabs() {
  const currentTab = getTabFromPath();

  // Bind tab button clicks
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as TabName;
      if (!TAB_NAMES.includes(tab)) return;

      const url = tab === 'overview' ? '/dashboard/' : `/dashboard/${tab}/`;
      history.pushState(null, '', url);
      activateTab(tab);
    });
  });

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    activateTab(getTabFromPath());
  });

  // Activate initial tab
  activateTab(currentTab);
}
