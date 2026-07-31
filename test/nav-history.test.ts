/**
 * Back, forward, and the list of where a window has been.
 *
 * The model is the browser's on purpose: visiting a page from the middle of
 * the stack drops the forward tail. The alternative — keeping both futures, or
 * a flat "recently visited" list — makes Back mean something the user has to
 * learn, and this bar sits next to a real browser's.
 */
import { describe, expect, it } from 'vitest';
import {
  NAV_HISTORY_LIMIT,
  canGoBack,
  canGoForward,
  createNavHistory,
  currentEntry,
  jumpTo,
  pushEntry,
  step,
} from '@/components/workspace/navHistory';
import { renderNavigation } from '@/components/workspace/navigation';

const visit = (routes: string[]) => routes.reduce(pushEntry, createNavHistory());

describe('the history stack', () => {
  it('starts empty, with nowhere to go', () => {
    const h = createNavHistory();
    expect(currentEntry(h)).toBeNull();
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  it('walks back and forward over what was visited', () => {
    const h = visit(['/', '/blog/', '/about/']);
    expect(currentEntry(h)).toBe('/about/');

    const back1 = step(h, -1);
    expect(back1.route).toBe('/blog/');
    const back2 = step(back1.history, -1);
    expect(back2.route).toBe('/');
    expect(canGoBack(back2.history)).toBe(false);
    expect(step(back2.history, -1).route).toBeNull();

    const fwd = step(back2.history, 1);
    expect(fwd.route).toBe('/blog/');
    expect(canGoForward(fwd.history)).toBe(true);
  });

  it('drops the forward tail when a new page is visited from the middle', () => {
    const h = visit(['/', '/blog/', '/about/']);
    const back = step(step(h, -1).history, -1).history; // at '/'
    const branched = pushEntry(back, '/contact/');

    expect(branched.entries).toEqual(['/', '/contact/']);
    expect(canGoForward(branched)).toBe(false);
  });

  it('ignores a re-visit of the page already shown', () => {
    // A reload, or the same route arriving from both the address bar and the
    // iframe's own navigation event, must not stack entries Back cannot leave.
    const h = pushEntry(pushEntry(createNavHistory(), '/blog/'), '/blog/');
    expect(h.entries).toEqual(['/blog/']);
  });

  it('keeps a bounded stack, dropping the oldest', () => {
    let h = createNavHistory();
    for (let i = 0; i < NAV_HISTORY_LIMIT + 10; i++) h = pushEntry(h, `/p${i}/`);
    expect(h.entries).toHaveLength(NAV_HISTORY_LIMIT);
    expect(currentEntry(h)).toBe(`/p${NAV_HISTORY_LIMIT + 9}/`);
    expect(h.entries[0]).toBe('/p10/');
  });

  it('jumps to an absolute entry, and refuses the one it is on', () => {
    const h = visit(['/', '/blog/', '/about/']);
    const jumped = jumpTo(h, 0);
    expect(jumped.route).toBe('/');
    expect(currentEntry(jumped.history)).toBe('/');
    expect(jumpTo(h, 2).route).toBeNull();
    expect(jumpTo(h, 99).route).toBeNull();
  });
});

describe('the navigation bar', () => {
  it('disables back and forward when there is nowhere to go', () => {
    const html = renderNavigation('preview', '/', createNavHistory());
    expect(html).toMatch(/data-action="ws-nav-back"[^>]*disabled/);
    expect(html).toMatch(/data-action="ws-nav-forward"[^>]*disabled/);
  });

  it('enables back once a second page was visited', () => {
    const html = renderNavigation('preview', '/blog/', visit(['/', '/blog/']));
    expect(html).not.toMatch(/data-action="ws-nav-back"[^>]*disabled/);
    // Nothing ahead of the newest entry.
    expect(html).toMatch(/data-action="ws-nav-forward"[^>]*disabled/);
  });

  it('lists the history newest first and marks where the window is', () => {
    const history = visit(['/', '/blog/', '/about/']);
    const html = renderNavigation('diff', '/about/', history, true);
    const items = [...html.matchAll(/data-index="(\d+)"/g)].map((m) => m[1]);
    expect(items).toEqual(['2', '1', '0']);
    expect(html).toContain('is-current');
    // The scope travels with every control, or the click drives the other window.
    expect(html).toMatch(/data-action="ws-nav-history-jump"[^>]*data-scope="diff"/);
  });

  it('keeps the list closed until it is asked for', () => {
    const html = renderNavigation('preview', '/', visit(['/', '/blog/']));
    expect(html).not.toContain('ws-nav__history-item');
    expect(html).toContain('aria-expanded="false"');
  });
});
