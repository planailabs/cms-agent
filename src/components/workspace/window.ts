/**
 * Main-area window state machine. The stage shows exactly ONE view at a
 * time: the base preview/diff, or a registered "window" (code browser,
 * commits, skills, archive, sessions, browser compare). Windows register
 * themselves here — the icon rail and the main renderer both derive from
 * the registry, so adding a window is a single registerWindow call in the
 * window's own module. `workspace.window` is the only open/closed state.
 */
import { store } from '../chat/app/store';
import type { AppState } from '../chat/app/state';
import type { WindowKind } from './state';

export type { WindowKind };

export interface WindowDef {
  kind: WindowKind;
  /** Rail icon (inline SVG). */
  icon: string;
  /** i18n key for the rail tooltip / aria-label. */
  tooltipKey: string;
  /** Rail button data-action (kept per-window for delegation + tests). */
  railAction: string;
  /** Rail position (ascending). */
  order: number;
  /** Renders the window — called only while it is the active window. */
  render: (state: AppState) => string;
  /** Data (re)load when the window becomes active. */
  onOpen?: () => void;
  /** Cleanup when it deactivates (switch or close). */
  onClose?: () => void;
  /** Rail button disabled (e.g. needs an active chat). */
  disabled?: (state: AppState) => boolean;
}

const registry = new Map<WindowKind, WindowDef>();

export const registerWindow = (def: WindowDef): void => {
  registry.set(def.kind, def);
};

export const registeredWindows = (): WindowDef[] =>
  [...registry.values()].sort((a, b) => a.order - b.order);

export const openWindow = (kind: WindowKind): void => {
  const ws = store.state.workspace;
  if (ws.window === kind) return;
  if (ws.window) registry.get(ws.window)?.onClose?.();
  ws.window = kind;
  store.notify();
  registry.get(kind)?.onOpen?.();
};

export const closeWindow = (): void => {
  const ws = store.state.workspace;
  if (!ws.window) return;
  registry.get(ws.window)?.onClose?.();
  ws.window = null;
  store.notify();
};

/** Rail click semantics: clicking the active window's icon closes it. */
export const toggleWindow = (kind: WindowKind): void => {
  if (store.state.workspace.window === kind) closeWindow();
  else openWindow(kind);
};

/** Markup of the active window, or null when the stage shows preview/diff. */
export const renderActiveWindow = (state: AppState): string | null => {
  const kind = state.workspace.window;
  const def = kind ? registry.get(kind) : undefined;
  return def ? def.render(state) : null;
};
