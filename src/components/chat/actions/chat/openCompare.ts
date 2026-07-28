import { store } from '../../app/store';
import { openWindow } from '@/components/workspace/window';
import type { DiffViewMode } from '@/components/workspace/state';

const MODES: DiffViewMode[] = ['side-by-side', 'scroll', 'highlight', 'onion'];

/**
 * open_compare — the agent puts the before/after view on screen. Like the
 * language hint this is a live SSE nudge for the user whose turn it is: it
 * touches only what the eye button touches, so nothing extra to persist.
 */
export const applyOpenCompare = (mode: unknown, userId: unknown): boolean => {
  if (userId !== store.state.user?.id) return false;
  if (MODES.includes(mode as DiffViewMode)) {
    store.state.workspace.diff.mode = mode as DiffViewMode;
  }
  openWindow('compare'); // notifies + lazy-loads the changed pages
  return true;
};
