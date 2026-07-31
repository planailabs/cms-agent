/**
 * compare_stale — the server says the site changed under the compare view.
 *
 * Shots are cached twice over: server-side per (route, shas, generation) and
 * in the browser for five minutes. Both are correct as long as the URL changes
 * with the content, which is what the generation is for — so reacting to this
 * event is mostly a matter of picking up the new number and rendering again.
 *
 * A closed compare window is left alone beyond dropping its `loaded` flag:
 * capturing screenshots nobody asked to see would cost two browser renders per
 * route, per turn.
 */
import { store } from '../chat/app/store';

export const applyCompareStale = (generation?: unknown): void => {
  const ws = store.state.workspace;
  if (typeof generation === 'number' && generation > ws.diff.generation) {
    ws.diff.generation = generation;
  }
  if (ws.window !== 'compare') {
    // Reopening reloads the page list (routes may have appeared or gone) and
    // with it the authoritative generation.
    ws.diff.loaded = false;
    return;
  }
  // Open: the page list may have changed too, and loadDiffPages refreshes the
  // generation, which is what gives every shot a new URL.
  //
  // Imported lazily on purpose. This module is reached from the chat's SSE
  // dispatcher, and workspace/actions imports the chat actions back: a static
  // edge here closes that cycle, and the client dies at boot on the first
  // binding the cycle evaluates out of order (see test/client-boot.test.ts).
  void import('./actions').then(({ loadDiffPages }) => loadDiffPages());
};
