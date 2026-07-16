/**
 * Navigation reporting — posts cms:navigation to the workspace on load and on
 * every SPA-style route change (astro:page-load, popstate, pushState).
 */
import type { AgentApi } from '../protocol';
import type { Listen } from './dom';

export const initNavigation = (agent: AgentApi, listen: Listen): void => {
  const nav = agent.safe(() => {
    agent.post({ type: 'cms:navigation', url: location.href, route: location.pathname });
  });

  nav(); // the engine loads modules only after DOMContentLoaded

  listen(document, 'astro:page-load', () => nav());
  listen(window, 'popstate', () => nav());

  const origPushState = history.pushState;
  try {
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = origPushState.apply(this, args);
      nav();
      return r;
    };
    agent.onTeardown(() => {
      history.pushState = origPushState;
    });
  } catch {
    /* ignore */
  }
};
