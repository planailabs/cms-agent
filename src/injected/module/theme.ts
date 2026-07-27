/**
 * Preview theme sync — the previewed site follows the workspace's dark/light
 * choice (cms:config, see config.ts). A page cannot override the browser's
 * prefers-color-scheme, so this emulates the chosen scheme for the standard
 * mechanisms sites actually use:
 *
 *  - `color-scheme` on <html> — UA defaults and `light-dark()` values
 *  - same-origin stylesheet `@media (prefers-color-scheme: …)` rules,
 *    rewritten to always/never match (compound conditions keep their
 *    other terms); re-applied when new styles appear (vite dev injects)
 *  - `window.matchMedia` — site-side theme toggles get the emulated
 *    matches and a change event when the workspace theme flips
 *
 * Constructed/adopted stylesheets are not covered (document.styleSheets
 * only). Everything is undone on teardown.
 */
import type { AgentApi } from '../protocol';
import { cfg, onConfigChange } from './config';

const PCS = /prefers-color-scheme/i;
const PCS_TERM = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;
/** Always/never-matching stand-ins that are valid inside compound queries. */
const ALWAYS = '(min-width: 0px)';
const NEVER = '(max-width: 0px)';

/** Rewrite prefers-color-scheme terms so `theme` appears to be the OS
 *  scheme. Exported for tests. */
export const rewriteCondition = (condition: string, theme: 'light' | 'dark'): string =>
  condition.replace(PCS_TERM, (_m, scheme: string) =>
    scheme.toLowerCase() === theme ? ALWAYS : NEVER,
  );

interface MqEvent {
  type: 'change';
  matches: boolean;
  media: string;
}
interface Shim {
  query: string;
  fns: Set<(ev: MqEvent) => void>;
  self: { onchange: ((ev: MqEvent) => void) | null };
}

export const initThemeSync = (agent: AgentApi): void => {
  const root = document.documentElement;
  const originalScheme = root.style.colorScheme;
  const saved: Array<{ media: MediaList; original: string }> = [];
  const shims: Shim[] = [];
  let applied: 'light' | 'dark' | null = null;

  const matchesFor = (query: string): boolean =>
    /dark/i.test(query) ? cfg.theme === 'dark' : /light/i.test(query) ? cfg.theme === 'light' : false;

  const restoreSheets = (): void => {
    for (const s of saved) {
      try {
        s.media.mediaText = s.original;
      } catch {
        /* sheet gone */
      }
    }
    saved.length = 0;
  };

  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const original = rule.media.mediaText;
        if (PCS.test(original)) {
          saved.push({ media: rule.media, original });
          rule.media.mediaText = rewriteCondition(original, cfg.theme);
        }
        walk(rule.cssRules);
      } else if (rule instanceof CSSGroupingRule) {
        walk(rule.cssRules);
      }
    }
  };

  const rewriteSheets = (): void => {
    restoreSheets();
    for (const sheet of Array.from(document.styleSheets)) {
      // Never touch our own overlay styles
      if (sheet.ownerNode instanceof Element && sheet.ownerNode.hasAttribute('data-cms-overlay')) {
        continue;
      }
      try {
        walk(sheet.cssRules);
      } catch {
        /* cross-origin sheet — media emulation can't reach it */
      }
    }
  };

  const apply = agent.safe((): void => {
    const flip = applied !== null && applied !== cfg.theme;
    applied = cfg.theme;
    root.style.colorScheme = cfg.theme;
    rewriteSheets();
    if (!flip) return;
    for (const shim of shims) {
      const ev: MqEvent = { type: 'change', matches: matchesFor(shim.query), media: shim.query };
      shim.self.onchange?.(ev);
      for (const fn of [...shim.fns]) fn(ev);
    }
  }) as () => void;

  // matchMedia shim for prefers-color-scheme queries (theme toggles listen)
  const nativeMM = window.matchMedia.bind(window);
  const patchedMM = (query: string): MediaQueryList => {
    if (!PCS.test(query)) return nativeMM(query);
    const fns = new Set<(ev: MqEvent) => void>();
    const self = {
      media: query,
      onchange: null as ((ev: MqEvent) => void) | null,
      get matches() {
        return matchesFor(query);
      },
      addEventListener(type: string, fn: (ev: MqEvent) => void) {
        if (type === 'change' && fn) fns.add(fn);
      },
      removeEventListener(_type: string, fn: (ev: MqEvent) => void) {
        fns.delete(fn);
      },
      addListener(fn: (ev: MqEvent) => void) {
        if (fn) fns.add(fn);
      },
      removeListener(fn: (ev: MqEvent) => void) {
        fns.delete(fn);
      },
      dispatchEvent: () => true,
    };
    shims.push({ query, fns, self });
    return self as unknown as MediaQueryList;
  };
  window.matchMedia = patchedMM as typeof window.matchMedia;

  // Late-arriving styles (vite dev injection, lazy CSS) need a re-rewrite —
  // the guard in apply() doesn't cover them, so rescan on style mutations.
  let rescan: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver((muts) => {
    const styleish = muts.some((m) =>
      [...m.addedNodes].some(
        (n) =>
          n instanceof Element &&
          (n.tagName === 'STYLE' || (n.tagName === 'LINK' && (n as HTMLLinkElement).rel === 'stylesheet')) &&
          !n.hasAttribute('data-cms-overlay'),
      ),
    );
    if (!styleish) return;
    if (rescan) clearTimeout(rescan);
    rescan = setTimeout(agent.safe(rewriteSheets) as () => void, 100);
  });
  observer.observe(root, { childList: true, subtree: true });

  onConfigChange(apply);
  apply();

  agent.onTeardown(() => {
    observer.disconnect();
    if (rescan) clearTimeout(rescan);
    window.matchMedia = nativeMM;
    restoreSheets();
    root.style.colorScheme = originalScheme;
    shims.length = 0;
  });
};
