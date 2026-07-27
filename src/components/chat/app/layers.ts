/**
 * Layer stack — client-only registry for transient UI layers (dialogs,
 * popovers, menus). One Esc listener closes the topmost open layer; one
 * document click listener closes outside-clicked popovers. Layers are
 * deliberately NOT persisted to the window session: windows
 * (workspace/window.ts) are what you're looking at, layers are what's
 * temporarily open on top of it.
 */
import { store } from './store';
import type { AppState } from './state';

export interface LayerDef {
  id: string;
  /** Higher sits closer to the top; Esc closes the topmost open layer. */
  priority: number;
  isOpen: (state: AppState) => boolean;
  close: () => void;
  /** Root selector — clicks outside it close the layer (popovers/menus).
   *  Matched via closest() on the click target, so it stays correct even
   *  when the opening click's rerender detached the original node. */
  outsideSelector?: string;
}

const layers: LayerDef[] = [];

export const registerLayer = (def: LayerDef): void => {
  layers.push(def);
  layers.sort((a, b) => b.priority - a.priority);
};

/** Close the topmost open layer; true when one was closed. */
export const closeTopLayer = (): boolean => {
  const top = layers.find((l) => l.isOpen(store.state));
  if (!top) return false;
  top.close();
  return true;
};

/** Close outside-clicked popover layers (several may close at once). */
export const closeOutsideLayers = (target: EventTarget | null): void => {
  const el = target instanceof Element ? target : null;
  for (const l of layers) {
    if (!l.outsideSelector || !l.isOpen(store.state)) continue;
    if (el?.closest(l.outsideSelector)) continue; // click inside the layer
    l.close();
  }
};

let installed = false;

/** Install the two global listeners (idempotent; call once at app init). */
export const installLayerListeners = (): void => {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (event) => closeOutsideLayers(event.target));
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (closeTopLayer()) event.preventDefault();
  });
};
